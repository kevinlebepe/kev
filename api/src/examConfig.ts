import { z } from 'zod';

// Exam configuration captured by the guided creation workflow (spec section 6).
export const examConfig = z.object({
  timing: z
    .object({
      durationMinutes: z.number().int().min(1).max(24 * 60).optional(),
      startWindowMinutes: z.number().int().min(0).max(24 * 60).default(15),
      lateEntryMinutes: z.number().int().min(0).max(24 * 60).default(0),
      autoSubmit: z.boolean().default(true),
    })
    .default({ startWindowMinutes: 15, lateEntryMinutes: 0, autoSubmit: true }),
  security: z
    .object({
      kiosk: z.boolean().default(true),
      screenCapture: z.boolean().default(false),
      camera: z.boolean().default(false),
      microphone: z.boolean().default(false),
      eventMonitoring: z.boolean().default(true),
    })
    .default({ kiosk: true, screenCapture: false, camera: false, microphone: false, eventMonitoring: true }),
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
      releaseAt: z.iso.datetime({ offset: true }).optional(),
      moderation: z.boolean().default(false),
    })
    .default({ autoMark: true, moderation: false }),
  navigation: z
    .object({ allowBacktrack: z.boolean().default(true), randomiseQuestionOrder: z.boolean().default(false) })
    .default({ allowBacktrack: true, randomiseQuestionOrder: false }),
  // Device requirements checked by the pre-exam readiness check (spec section 10).
  device: z
    .object({
      supportedOs: z.array(z.enum(['windows', 'macos', 'linux', 'chromeos'])).min(1).default(['windows', 'macos']),
      minAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
      minFreeStorageMb: z.number().int().min(0).max(1_000_000).default(2048),
      allowExternalMonitors: z.boolean().default(false),
      allowVirtualMachines: z.boolean().default(false),
    })
    .default({ supportedOs: ['windows', 'macos'], minFreeStorageMb: 2048, allowExternalMonitors: false, allowVirtualMachines: false }),
});

export type ExamConfig = z.infer<typeof examConfig>;
