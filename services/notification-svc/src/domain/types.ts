/**
 * Notification types and their placeholder allowlists (Component Prompt 13 §6). A template may use
 * only its type's placeholders; `{Recipient_Name}` is available to every type.
 */
export type Channel = 'email' | 'in_app';

export interface TypeSpec {
  /** Placeholders a template of this type may use (besides `{Recipient_Name}`). */
  placeholders: readonly string[];
  /** Transactional types cannot be switched off and skip quiet hours and the daily cap. */
  transactional: boolean;
  /** Channels sent by default; tenant preferences narrow them. */
  channels: readonly Channel[];
  /** Carries a bearer link (`{URL}` from the request, stored only until sent). */
  secretLink: boolean;
}

export const COMMON_PLACEHOLDERS = ['Recipient_Name'] as const;

export const NOTIFICATION_TYPES = {
  invitation: {
    placeholders: ['URL', 'Expires_At'],
    transactional: true,
    channels: ['email'],
    secretLink: true,
  },
  magic_link: {
    placeholders: ['URL', 'Expires_At'],
    transactional: true,
    channels: ['email'],
    secretLink: true,
  },
  candidate_assessment_invitation: {
    placeholders: ['Candidate_Name', 'Assessment_Name', 'URL', 'Expires_At'],
    transactional: true,
    channels: ['email'],
    secretLink: true,
  },
  assessment_submitted: {
    placeholders: ['Session_Id', 'Assessment_Id', 'Outcome', 'Link_Path'],
    transactional: false,
    channels: ['in_app', 'email'],
    secretLink: false,
  },
  assessment_terminated: {
    placeholders: ['Session_Id', 'Assessment_Id', 'Reason', 'Link_Path'],
    transactional: false,
    channels: ['in_app', 'email'],
    secretLink: false,
  },
  proctoring_review_required: {
    placeholders: ['Session_Id', 'Trust_Score', 'Band', 'Link_Path'],
    transactional: false,
    channels: ['in_app', 'email'],
    secretLink: false,
  },
  interview_review_required: {
    placeholders: ['Session_Id', 'Link_Path'],
    transactional: false,
    channels: ['in_app', 'email'],
    secretLink: false,
  },
  attrition_alert: {
    placeholders: ['Employee_Id', 'Drivers', 'Link_Path'],
    transactional: false,
    channels: ['in_app', 'email'],
    secretLink: false,
  },
  report_ready: {
    placeholders: ['Report_Type', 'Link_Path'],
    transactional: true,
    channels: ['in_app'],
    secretLink: false,
  },
  webhook_disabled: {
    placeholders: ['Endpoint_Url', 'Failures', 'Link_Path'],
    transactional: true,
    channels: ['in_app', 'email'],
    secretLink: false,
  },
  self_rating_reminder: {
    placeholders: ['Employee_Name', 'Due_Date', 'URL'],
    transactional: false,
    channels: ['email', 'in_app'],
    secretLink: false,
  },
  manager_rating_reminder: {
    placeholders: ['Employee_Name', 'Manager_Name', 'Due_Date', 'URL'],
    transactional: false,
    channels: ['email', 'in_app'],
    secretLink: false,
  },
} as const satisfies Record<string, TypeSpec>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const TYPE_NAMES = Object.keys(NOTIFICATION_TYPES) as NotificationType[];

export function isNotificationType(value: string): value is NotificationType {
  return Object.hasOwn(NOTIFICATION_TYPES, value);
}

export function specOf(type: NotificationType): TypeSpec {
  return NOTIFICATION_TYPES[type];
}

export function allowedPlaceholders(type: NotificationType): string[] {
  return [...COMMON_PLACEHOLDERS, ...specOf(type).placeholders];
}
