export interface CodexTextInput { type: "text"; text: string }
export interface CodexLocalImageInput { type: "localImage"; path: string }
export type CodexInput = CodexTextInput | CodexLocalImageInput;

export interface PastedAttachment {
  mimeType: "image/png" | "image/jpeg" | "application/pdf";
  dataUrl: string;
  name?: string;
}

export type PastedImage = PastedAttachment;
