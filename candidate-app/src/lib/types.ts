export interface Requirements {
  timing: { durationMinutes?: number; autoSubmit: boolean };
  security: { kiosk: boolean; screenCapture: boolean; camera: boolean; microphone: boolean; eventMonitoring: boolean };
  offline: { allowed: boolean; maxOfflineMinutes: number };
  device: {
    supportedOs: string[];
    minAppVersion?: string;
    minFreeStorageMb: number;
    allowExternalMonitors: boolean;
    allowVirtualMachines: boolean;
  };
}

export interface ReadinessCheck {
  key: string;
  passed: boolean;
  message: string;
}

export interface Entitlement {
  id: string;
  status: 'assigned' | 'precheck_complete' | 'active' | 'submitted' | 'completed';
  sessionId: string;
  sessionName: string;
  sessionStatus: string;
  startsAt: string;
  endsAt: string;
  examName: string;
  examCode: string;
  examVersion: number;
  lastCheckPassed: boolean | null;
  lastChecks: ReadinessCheck[] | null;
  lastCheckedAt: string | null;
  requirements: Requirements;
}

export interface ManifestQuestion {
  id: string;
  type: string;
  prompt: string;
  points: number;
  options: { id: string; label: string }[];
}

export interface ExamManifest {
  examId: string;
  version: number;
  code: string;
  name: string;
  description: string;
  config: Requirements & { navigation: { allowBacktrack: boolean } };
  questions: ManifestQuestion[];
}

export interface ExamPackage {
  keyId: string;
  exam: { manifest: ExamManifest; manifestSha256: string; signature: string; keyId: string };
  entitlement: {
    payload: { assignmentId: string; manifestSha256: string; notBefore: string; notAfter: string };
    signature: string;
  };
}

export type AnswerResponse = { optionId: string } | { optionIds: string[] } | { text: string };

export interface SavedAnswer {
  questionId: string;
  response: AnswerResponse;
  seq: number;
}

export interface Receipt {
  receiptId: string;
  attemptId: string;
  submittedAt: string;
  submittedBy: 'candidate' | 'timer' | 'system';
  answered: number;
  total: number;
  packageSha256: string;
  signature: string;
}

export interface AttemptView {
  id: string;
  assignmentId: string;
  status: 'active' | 'submitted' | 'completed' | 'abandoned';
  startedAt: string;
  deadlineAt: string;
  /** Server time when this response was produced; anchors the countdown. */
  serverTime: string;
  position: number;
  answers: SavedAnswer[];
  receipt: Receipt | null;
  resumed?: boolean;
}
