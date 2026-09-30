import { z } from 'zod';

// Exam configuration captured by the guided creation workflow (spec section 6).
export const examConfig = z.object({
  timing: z
    .object({
      durationMinutes: z.number().int().min(1).max(24 * 60).optional(),
      startWindowMinutes: z.number().int().min(0).max(24 * 60).default(15),
      lateEntryMinutes: z.number().int().min(0).max(24 * 60).default(0),
      // There is no setting for automatic submission: the server owns the timer
      // and always closes an attempt at its deadline, so answers are never lost.
    })
    .default({ startWindowMinutes: 15, lateEntryMinutes: 0 }),
  security: z
    .object({
      kiosk: z.boolean().default(true),
      screenCapture: z.boolean().default(false),
      camera: z.boolean().default(false),
      microphone: z.boolean().default(false),
      eventMonitoring: z.boolean().default(true),
      // Exam rules. The app detects and reports; the server counts and decides.
      fullscreen: z.boolean().default(true),
      blockClipboard: z.boolean().default(true),
      // flag: record for review. warn_then_submit: warn, then end the exam after
      // more than maxViolations. submit_immediately: end the exam at the first one.
      violationPolicy: z.enum(['flag', 'warn_then_submit', 'submit_immediately']).default('flag'),
      maxViolations: z.number().int().min(1).max(20).default(3),
    })
    .default({
      kiosk: true,
      screenCapture: false,
      camera: false,
      microphone: false,
      eventMonitoring: true,
      fullscreen: true,
      blockClipboard: true,
      violationPolicy: 'flag',
      maxViolations: 3,
    }),
  invigilation: z
    .object({
      required: z.boolean().default(false),
      // The platform ceiling is 10; organisations can only lower it.
      maxCandidatesPerInvigilator: z.number().int().min(1).max(10).default(10),
      rotationMinutes: z.number().int().min(0).max(24 * 60).default(0),
      communication: z.enum(['voice', 'text', 'voice_and_text']).default('voice_and_text'),
    })
    .default({ required: false, maxCandidatesPerInvigilator: 10, rotationMinutes: 0, communication: 'voice_and_text' }),
  offline: z
    .object({
      allowed: z.boolean().default(true),
      maxOfflineMinutes: z.number().int().min(0).max(24 * 60).default(30),
    })
    .default({ allowed: true, maxOfflineMinutes: 30 }),
  results: z
    .object({
      autoMark: z.boolean().default(true),
      // Multiple response questions: all or nothing, or a share of the marks
      // for each correct choice less each wrong one (never below zero).
      partialCredit: z.enum(['none', 'proportional']).default('none'),
      // Results are released on this date without anyone pressing release; results marked later follow as they are marked.
      releaseAt: z.iso.datetime({ offset: true }).optional(),
      // A second person (with result:release, and not a marker of the script) confirms the marks before release.
      moderation: z.boolean().default(false),
    })
    .default({ autoMark: true, partialCredit: 'none', moderation: false }),
  navigation: z
    .object({ allowBacktrack: z.boolean().default(true), randomiseQuestionOrder: z.boolean().default(false) })
    .default({ allowBacktrack: true, randomiseQuestionOrder: false }),
  // Device requirements checked by the pre-exam readiness check (spec section 10).
  device: z
    .object({
      supportedOs: z.array(z.enum(['windows', 'macos', 'linux', 'chromeos', 'android', 'ios'])).min(1).default(['windows', 'macos']),
      minAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
      minFreeStorageMb: z.number().int().min(0).max(1_000_000).default(2048),
      allowExternalMonitors: z.boolean().default(false),
      allowVirtualMachines: z.boolean().default(false),
      // On a laptop or desktop computer the exam can only be taken in the
      // ExamGuard desktop application, which can lock the computer down in ways
      // a browser cannot. Phones, tablets and Chromebooks cannot run it and use
      // the browser, so the organisation's own device management must lock those.
      requireDesktopApp: z.boolean().default(false),
    })
    .default({
      supportedOs: ['windows', 'macos'],
      minFreeStorageMb: 2048,
      allowExternalMonitors: false,
      allowVirtualMachines: false,
      requireDesktopApp: false,
    }),
});

export type ExamConfig = z.infer<typeof examConfig>;
