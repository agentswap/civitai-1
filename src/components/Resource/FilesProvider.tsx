import { constants, ModelFileType } from '~/server/common/constants';
import { ModelUpsertInput } from '~/server/schema/model.schema';
import { ModelVersionById } from '~/types/router';
import { createContext, useContext, useState } from 'react';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { isDefined } from '~/utils/type-guards';
import { bytesToKB } from '~/utils/number-helpers';
import { randomId } from '@mantine/hooks';
import { hideNotification, showNotification } from '@mantine/notifications';
import { Anchor, Stack, Text } from '@mantine/core';
import Link from 'next/link';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ModelStatus, ModelType } from '@prisma/client';
import { UploadType } from '~/server/common/enums';
import { modelFileMetadataSchema } from '~/server/schema/model-file.schema';
import { z } from 'zod';
import { getModelFileFormat } from '~/utils/file-helpers';

type ZodErrorSchema = { _errors: string[] };
type SchemaError = {
  type?: ZodErrorSchema;
  size?: ZodErrorSchema;
  fp?: ZodErrorSchema;
};

export type FileFromContextProps = {
  id?: number;
  name: string;
  modelType?: ModelType | null;
  type?: ModelFileType | null;
  sizeKB?: number;
  size?: 'full' | 'pruned' | null;
  fp?: 'fp16' | 'fp32' | null;
  versionId?: number;
  file?: File;
  uuid: string;
  isPending?: boolean;
  isUploading?: boolean;
};

type FilesContextState = {
  hasPending: boolean;
  errors: SchemaError[] | null;
  files: FileFromContextProps[];
  modelId?: number;
  fileExtensions: string[];
  fileTypes: ModelFileType[];
  maxFiles: number;
  onDrop: (files: File[]) => void;
  startUpload: () => Promise<void>;
  retry: (uuid: string) => Promise<void>;
  updateFile: (uuid: string, file: Partial<FileFromContextProps>) => void;
  removeFile: (uuid: string) => void;
  validationCheck: () => boolean;
};

type FilesProviderProps = {
  model?: Partial<ModelUpsertInput>;
  version?: Partial<ModelVersionById>;
  children: React.ReactNode;
};

const FilesContext = createContext<FilesContextState | null>(null);
export const useFilesContext = () => {
  const context = useContext(FilesContext);
  if (!context) throw new Error('FilesContext not in tree');
  return context;
};

export function FilesProvider({ model, version, children }: FilesProviderProps) {
  const queryUtils = trpc.useContext();
  const upload = useS3UploadStore((state) => state.upload);
  const setItems = useS3UploadStore((state) => state.setItems);

  const [errors, setErrors] = useState<SchemaError[] | null>(null);
  const [files, setFiles] = useState<FileFromContextProps[]>(() => {
    const initialFiles = (version?.files?.map((file) => ({
      id: file.id,
      name: file.name,
      type: file.type as ModelFileType,
      sizeKB: file.sizeKB,
      size: file.metadata.size,
      fp: file.metadata.fp,
      versionId: version.id,
      uuid: randomId(),
      modelType: model?.type ?? null,
    })) ?? []) as FileFromContextProps[];
    const uploading = useS3UploadStore
      .getState()
      .items.filter((x) => x.meta?.versionId === version?.id)
      .map((item) => ({
        name: item.name,
        sizeKB: bytesToKB(item.size),
        file: item.file,
        // persisted through meta
        uuid: item.meta?.uuid ?? randomId(),
        type: item.meta?.type,
        size: item.meta?.size,
        fp: item.meta?.fp,
        versionId: item.meta?.versionId,
      })) as FileFromContextProps[];
    return [...initialFiles, ...uploading].filter(isDefined);
  });

  const handleUpdateFile = (uuid: string, file: Partial<FileFromContextProps>) => {
    setFiles((state) => {
      const index = state.findIndex((x) => x.uuid === uuid);
      if (index === -1) throw new Error('out of bounds');
      state[index] = { ...state[index], ...file };
      return [...state];
    });
  };

  const removeFile = (uuid: string) => {
    setFiles((state) => state.filter((x) => x.uuid !== uuid));
  };

  const publishModelMutation = trpc.model.publish.useMutation({
    async onSuccess(_, variables) {
      hideNotification('publishing-version');
      const modelId = variables.id;
      const modelVersionId = variables.versionIds?.[0];
      showPublishedNotification(modelId, modelVersionId);
    },
    onError(error) {
      hideNotification('publishing-version');
      showErrorNotification({
        title: 'Failed to publish version',
        error: new Error(error.message),
      });
    },
  });
  const publishVersionMutation = trpc.modelVersion.publish.useMutation({
    async onSuccess(results) {
      hideNotification('publishing-version');
      if (results) showPublishedNotification(results.modelId, results.id);
    },
    onError(error) {
      hideNotification('publishing-version');
      showErrorNotification({
        title: 'Failed to publish version',
        error: new Error(error.message),
      });
    },
  });

  const showPublishedNotification = async (modelId: number, modelVersionId?: number) => {
    const pubNotificationId = `version-published-${modelVersionId}`;
    showNotification({
      id: pubNotificationId,
      title: 'Version published',
      color: 'green',
      styles: { root: { alignItems: 'flex-start' } },
      message: (
        <Stack spacing={4}>
          <Text size="sm" color="dimmed">
            Your version has been published and is now available to the public.
          </Text>
          <Link href={`/models/${modelId}?modelVersionId=${modelVersionId}`} passHref>
            <Anchor size="sm" onClick={() => hideNotification(pubNotificationId)}>
              Go to model
            </Anchor>
          </Link>
        </Stack>
      ),
    });

    await queryUtils.model.getById.invalidate({ id: modelId });
    if (modelVersionId)
      await queryUtils.modelVersion.getById.invalidate({
        id: modelVersionId,
      });
  };

  const checkValidation = () => {
    setErrors(null);

    const validation = metadataSchema.safeParse(files);
    if (!validation.success) {
      const errors = validation.error.format() as unknown as Array<{
        [k: string]: ZodErrorSchema;
      }>;
      console.log(errors);
      setErrors(errors);
      return false;
    }

    const noConflicts = checkConflictingFiles(files);
    if (!noConflicts) {
      showErrorNotification({
        title: 'Duplicate file types',
        error: new Error(
          'There are multiple files with the same type and size, please adjust your files'
        ),
      });
    }
    return noConflicts;
  };

  const createFileMutation = trpc.modelFile.create.useMutation({
    async onSuccess(result) {
      const hasPublishedPosts = result.modelVersion._count.posts > 0;
      const isVersionPublished = result.modelVersion.status === ModelStatus.Published;
      const { uploading } = useS3UploadStore
        .getState()
        .getStatus((item) => item.meta?.versionId === result.modelVersion.id);
      const stillUploading = uploading > 0;

      const notificationId = `upload-finished-${result.id}`;
      showNotification({
        id: notificationId,
        autoClose: stillUploading,
        color: 'green',
        title: `Finished uploading ${result.name}`,
        styles: { root: { alignItems: 'flex-start' } },
        message: !stillUploading ? (
          <Stack spacing={4}>
            {isVersionPublished ? (
              <>
                <Text size="sm" color="dimmed">
                  All files finished uploading.
                </Text>
                <Link
                  href={`/models/${model?.id}?modelVersionId=${result.modelVersion.id}`}
                  passHref
                >
                  <Anchor size="sm" onClick={() => hideNotification(notificationId)}>
                    Go to model
                  </Anchor>
                </Link>
              </>
            ) : hasPublishedPosts ? (
              <>
                <Text size="sm" color="dimmed">
                  {`Your files have finished uploading, let's publish this version.`}
                </Text>
                <Text
                  variant="link"
                  size="sm"
                  sx={{ cursor: 'pointer' }}
                  onClick={() => {
                    hideNotification(notificationId);

                    showNotification({
                      id: 'publishing-version',
                      message: 'Publishing...',
                      loading: true,
                    });

                    if (model?.status !== ModelStatus.Published)
                      publishModelMutation.mutate({
                        id: model?.id as number,
                        versionIds: [result.modelVersion.id],
                      });
                    else publishVersionMutation.mutate({ id: result.modelVersion.id });
                  }}
                >
                  Publish it
                </Text>
              </>
            ) : (
              <>
                <Text size="sm" color="dimmed">
                  Your files have finished uploading, but you still need to add a post.
                </Text>
                <Link
                  href={`/models/${model?.id}/model-versions/${result.modelVersion.id}/wizard?step=3`}
                  passHref
                >
                  <Anchor size="sm" onClick={() => hideNotification(notificationId)}>
                    Finish setup
                  </Anchor>
                </Link>
              </>
            )}
          </Stack>
        ) : undefined,
      });

      await queryUtils.modelVersion.getById.invalidate({ id: result.modelVersion.id });
      if (model) await queryUtils.model.getById.invalidate({ id: model.id });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to save file',
        reason: 'Could not save file, please try again.',
        error: new Error(error.message),
      });
    },
  });

  const onDrop = (files: File[]) => {
    const toUpload = files.map((file) => ({
      name: file.name,
      versionId: version?.id,
      modelType: model?.type,
      file,
      status: 'pending',
      sizeKB: bytesToKB(file.size),
      uuid: randomId(),
      isPending: true,
    })) as FileFromContextProps[];
    setFiles((state) => [...state, ...toUpload]);
  };

  const handleUpload = async ({ type, size, fp, versionId, file, uuid }: FileFromContextProps) => {
    if (!file || !type) return;
    setFiles((state) => {
      const index = state.findIndex((x) => x.uuid === uuid);
      if (index === -1) throw new Error('out of bounds');
      state[index] = { ...state[index], isPending: false, isUploading: true };
      return [...state];
    });

    return await upload(
      {
        file,
        type: type === 'Model' ? UploadType.Model : UploadType.Default,
        meta: { versionId, type, size, fp, uuid },
      },
      async ({ meta, size, ...result }) => {
        const { versionId, type, uuid, ...metadata } = meta as {
          versionId: number;
          type: ModelFileType;
          uuid: string;
        };
        if (versionId) {
          try {
            const saved = await createFileMutation.mutateAsync({
              ...result,
              sizeKB: bytesToKB(size),
              modelVersionId: versionId,
              type,
              metadata,
            });
            setItems((items) => items.filter((x) => x.uuid !== result.uuid));
            setFiles((state) => {
              const index = state.findIndex((x) => x.uuid === uuid);
              state[index] = { ...state[index], id: saved.id, isUploading: false };
              return [...state];
            });
          } catch (e: unknown) {}
        }
      }
    );
  };

  const startUpload = async () => {
    const toUpload = files.filter((x) => x.isPending && !!x.file);

    await Promise.all(
      toUpload.map((file) => {
        if (!checkValidation()) return;

        handleUpload(file);
      })
    );
  };

  const retry = async (uuid: string) => {
    const file = files.find((x) => x.uuid === uuid);
    if (!file) return;
    await handleUpload(file);
  };

  const { acceptedModelFiles, acceptedFileTypes, maxFiles } =
    dropzoneOptionsByModelType[model?.type ?? 'Checkpoint'];

  return (
    <FilesContext.Provider
      value={{
        files,
        onDrop,
        startUpload,
        errors: errors,
        hasPending: files.some((x) => x.isPending),
        retry,
        updateFile: handleUpdateFile,
        removeFile,
        fileExtensions: acceptedFileTypes,
        fileTypes: acceptedModelFiles,
        modelId: model?.id,
        maxFiles,
        validationCheck: checkValidation,
      }}
    >
      {children}
    </FilesContext.Provider>
  );
}

const metadataSchema = modelFileMetadataSchema
  .extend({
    versionId: z.number(),
    type: z.enum(constants.modelFileTypes),
    modelType: z.nativeEnum(ModelType),
  })
  .refine(
    (data) => (data.type === 'Model' && data.modelType === 'Checkpoint' ? !!data.size : true),
    {
      message: 'Model size is required for model files',
      path: ['size'],
    }
  )
  .refine((data) => (data.type === 'Model' && data.modelType === 'Checkpoint' ? !!data.fp : true), {
    message: 'Floating point is required for model files',
    path: ['fp'],
  })
  .array();

// TODO.manuel: This is a hacky way to check for duplicates
export const checkConflictingFiles = (files: FileFromContextProps[]) => {
  const conflictCount: Record<string, number> = {};

  files.forEach((item) => {
    const key = [item.size, item.type, item.fp, getModelFileFormat(item.name)]
      .filter(Boolean)
      .join('-');
    if (conflictCount[key]) conflictCount[key] += 1;
    else conflictCount[key] = 1;
  });

  return Object.values(conflictCount).every((count) => count === 1);
};

type DropzoneOptions = {
  acceptedFileTypes: string[];
  acceptedModelFiles: ModelFileType[];
  maxFiles: number;
};

const dropzoneOptionsByModelType: Record<ModelType, DropzoneOptions> = {
  App: {
    acceptedFileTypes: [],
    acceptedModelFiles: [],
    maxFiles: 0,
  },
  Checkpoint: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip', '.yaml', '.yml'],
    acceptedModelFiles: ['Model', 'Config', 'VAE', 'Training Data'],
    maxFiles: 11,
  },
  LORA: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip', '.yaml', '.yml'],
    acceptedModelFiles: ['Model', 'Text Encoder', 'Training Data'],
    maxFiles: 4,
  },
  LoCon: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip', '.yaml', '.yml'],
    acceptedModelFiles: ['Model', 'Text Encoder', 'Training Data'],
    maxFiles: 4,
  },
  TextualInversion: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Negative', 'Training Data'],
    maxFiles: 3,
  },
  Hypernetwork: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Training Data'],
    maxFiles: 2,
  },
  AestheticGradient: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Training Data'],
    maxFiles: 2,
  },
  Controlnet: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.yaml', '.yml'],
    acceptedModelFiles: ['Model', 'Config'],
    maxFiles: 3,
  },
  Poses: { acceptedFileTypes: ['.zip'], acceptedModelFiles: ['Archive'], maxFiles: 1 },
  Wildcards: { acceptedFileTypes: ['.zip'], acceptedModelFiles: ['Archive'], maxFiles: 1 },
  Other: { acceptedFileTypes: ['.zip'], acceptedModelFiles: ['Archive'], maxFiles: 1 },
};
