export type AuthenticationStatus =
  | "checking"
  | "unauthenticated"
  | "logging_in"
  | "authenticated"
  | "error";

export interface AuthenticationState {
  status: AuthenticationStatus;
  authMode?: string;
  email?: string;
  planType?: string;
  loginId?: string;
  verificationUrl?: string;
  userCode?: string;
  error?: string;
}

export interface AccountSnapshot {
  account: {
    type: string;
    email?: string;
    planType?: string;
  } | null;
  requiresOpenaiAuth: boolean;
}

export type LoginStartResult =
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | { type: "chatgptDeviceCode"; loginId: string; verificationUrl: string; userCode: string };
