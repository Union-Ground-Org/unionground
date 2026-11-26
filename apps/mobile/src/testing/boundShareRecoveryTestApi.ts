import type * as ShareApi from '../services/secureShareIntake';
import { stubAttachmentWriter } from './stubAttachmentWriter';

export function boundShareRecoveryTestApi(api: typeof ShareApi, getClient: () => unknown, owner: () => string) {
  const writer = () => stubAttachmentWriter(getClient, owner());
  return {
    ...api,
    beginPendingSharedAttachmentUpload: (...args: Parameters<typeof api.beginPendingSharedAttachmentUpload>) => api.beginPendingSharedAttachmentUpload(args[0], args[1], args[2] ?? writer()),
    uploadPendingSharedAttachment: (...args: Parameters<typeof api.uploadPendingSharedAttachment>) => api.uploadPendingSharedAttachment(args[0], args[1], args[2] ?? writer()),
    reconcilePendingSharedAttachmentUploadRecovery: (...args: Parameters<typeof api.reconcilePendingSharedAttachmentUploadRecovery>) => api.reconcilePendingSharedAttachmentUploadRecovery(args[0] ?? writer()),
    preparePendingSharedAttachmentUploadForSessionEstablishment: (...args: Parameters<typeof api.preparePendingSharedAttachmentUploadForSessionEstablishment>) => api.preparePendingSharedAttachmentUploadForSessionEstablishment(args[0], args[1] ?? writer()),
    preparePendingSharedAttachmentUploadForSignOut: (...args: Parameters<typeof api.preparePendingSharedAttachmentUploadForSignOut>) => api.preparePendingSharedAttachmentUploadForSignOut(args[0], args[1], args[2] ?? writer()),
    getPendingSharedAttachmentUpload: (...args: Parameters<typeof api.getPendingSharedAttachmentUpload>) => api.getPendingSharedAttachmentUpload(args[0] ?? owner()),
  };
}
