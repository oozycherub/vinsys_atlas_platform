import { type Channel, type NotificationType } from './types';

/** Built-in templates, used until a tenant saves its own (they pass validateTemplate too). */
export interface TemplateText {
  subject: string;
  source: string;
}

function email(heading: string, body: string, button?: string): string {
  const action = button
    ? `<mj-button href="{URL}" background-color="#1f4fd1">${button}</mj-button>`
    : '';
  return `<mjml>
  <mj-head><mj-attributes><mj-all font-family="Arial, sans-serif" /></mj-attributes></mj-head>
  <mj-body background-color="#f4f5f7">
    <mj-section background-color="#ffffff" padding="24px">
      <mj-column>
        <mj-text font-size="20px" font-weight="bold">${heading}</mj-text>
        <mj-text font-size="15px" line-height="22px">${body}</mj-text>
        ${action}
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
}

const EMAIL: Record<NotificationType, TemplateText> = {
  invitation: {
    subject: 'You have been invited to Atlas',
    source: email(
      'Welcome to Atlas',
      'Hello {Recipient_Name}, you have been invited. The link expires on {Expires_At}.',
      'Accept invitation',
    ),
  },
  magic_link: {
    subject: 'Your Atlas sign-in link',
    source: email(
      'Sign in to Atlas',
      'Use this link to sign in. It expires on {Expires_At} and works once.',
      'Sign in',
    ),
  },
  candidate_assessment_invitation: {
    subject: 'Your assessment: {Assessment_Name}',
    source: email(
      '{Assessment_Name}',
      'Hello {Candidate_Name}, you have been invited to an assessment. The link expires on {Expires_At}.',
      'Start the assessment',
    ),
  },
  assessment_submitted: {
    subject: 'An assessment was submitted',
    source: email(
      'Assessment submitted',
      'Session {Session_Id} was submitted ({Outcome}). Open Atlas at {Link_Path} to review it.',
    ),
  },
  assessment_terminated: {
    subject: 'An assessment was terminated',
    source: email(
      'Assessment terminated',
      'Session {Session_Id} was terminated: {Reason}. Open Atlas at {Link_Path}.',
    ),
  },
  proctoring_review_required: {
    subject: 'A proctored session needs review',
    source: email(
      'Integrity review needed',
      'Session {Session_Id} finished with Trust Score {Trust_Score} ({Band}). A reviewer must decide. Open Atlas at {Link_Path}.',
    ),
  },
  interview_review_required: {
    subject: 'An AI interview needs review',
    source: email(
      'Interview review needed',
      'Session {Session_Id} has an AI interview that needs a human review. Open Atlas at {Link_Path}.',
    ),
  },
  attrition_alert: {
    subject: 'Retention alert for one of your people',
    source: email(
      'Retention alert',
      'An employee may be at risk of leaving. Main factors: {Drivers}. Open Atlas at {Link_Path} for suggested actions.',
    ),
  },
  report_ready: {
    subject: 'Your report is ready',
    source: email('Report ready', 'Your {Report_Type} report is ready at {Link_Path}.'),
  },
  webhook_disabled: {
    subject: 'A webhook endpoint was disabled',
    source: email(
      'Webhook endpoint disabled',
      'Deliveries to {Endpoint_Url} failed {Failures} times in a row, so the endpoint was disabled. Fix it and re-enable it at {Link_Path}.',
    ),
  },
  self_rating_reminder: {
    subject: 'Reminder: rate your skills by {Due_Date}',
    source: email(
      'Skill self-rating',
      'Hello {Recipient_Name}, please complete your skill self-rating by {Due_Date}.',
      'Rate my skills',
    ),
  },
  manager_rating_reminder: {
    subject: 'Reminder: rate {Employee_Name} by {Due_Date}',
    source: email(
      'Manager rating',
      'Hello {Recipient_Name}, please rate the skills of {Employee_Name} by {Due_Date}.',
      'Rate now',
    ),
  },
};

const IN_APP: Partial<Record<NotificationType, TemplateText>> = {
  assessment_submitted: {
    subject: 'Assessment submitted',
    source: 'Session {Session_Id} was submitted ({Outcome}).',
  },
  assessment_terminated: {
    subject: 'Assessment terminated',
    source: 'Session {Session_Id} was terminated: {Reason}.',
  },
  proctoring_review_required: {
    subject: 'Integrity review needed',
    source: 'Session {Session_Id}: Trust Score {Trust_Score} ({Band}).',
  },
  interview_review_required: {
    subject: 'Interview review needed',
    source: 'Session {Session_Id} has an AI interview to review.',
  },
  attrition_alert: { subject: 'Retention alert', source: 'Main factors: {Drivers}.' },
  report_ready: { subject: 'Report ready', source: 'Your {Report_Type} report is ready.' },
  webhook_disabled: {
    subject: 'Webhook endpoint disabled',
    source: '{Endpoint_Url} failed {Failures} times in a row and was disabled.',
  },
  self_rating_reminder: {
    subject: 'Skill self-rating due {Due_Date}',
    source: 'Please complete your skill self-rating.',
  },
  manager_rating_reminder: {
    subject: 'Rate {Employee_Name} by {Due_Date}',
    source: 'Please rate the skills of {Employee_Name}.',
  },
};

export function defaultTemplate(type: NotificationType, channel: Channel): TemplateText | null {
  return channel === 'email' ? EMAIL[type] : (IN_APP[type] ?? null);
}
