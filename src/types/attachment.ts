export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  fileSize: number;
  createdAt: string;
  uploadedBy?: {
    id: string;
    name: string;
  };
}
