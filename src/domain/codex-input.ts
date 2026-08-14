export interface CodexTextInput { type: "text"; text: string }
export interface CodexLocalImageInput { type: "localImage"; path: string }
export type CodexInput = CodexTextInput | CodexLocalImageInput;

export interface PastedImage {
  mimeType: "image/png" | "image/jpeg";
  dataUrl: string;
}
