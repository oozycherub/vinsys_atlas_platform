/** Minimal message catalogue with RTL (Arabic) support (Component Prompt 14 §6). */
export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];

const en = {
  'app.name': 'Atlas',
  'nav.skip': 'Skip to main content',
  'nav.admin': 'Admin',
  'nav.recruiter': 'Recruiting',
  'nav.employee': 'My workspace',
  'nav.notifications': 'Notifications',
  'nav.signOut': 'Sign out',
  'nav.language': 'العربية',
  'login.title': 'Sign in to your workspace',
  'login.email': 'Work email',
  'login.submit': 'Email me a sign-in link',
  'login.sent': 'Check your inbox: we sent a sign-in link that works for 30 minutes.',
  'common.loading': 'Loading…',
  'common.error': 'Something went wrong. Please try again.',
  'common.save': 'Save',
  'common.create': 'Create',
  'runner.start': 'Start the assessment',
  'runner.submit': 'Submit assessment',
  'runner.saved': 'All answers saved',
  'runner.saving': 'Saving…',
  'runner.offline':
    'You are offline. Your answers are kept on this device and will be sent when you reconnect.',
  'runner.timeLeft': 'Time left',
  'runner.done': 'Your answers have been submitted. You can close this window.',
} as const;

export type MessageKey = keyof typeof en;

const ar: Record<MessageKey, string> = {
  'app.name': 'أطلس',
  'nav.skip': 'انتقل إلى المحتوى الرئيسي',
  'nav.admin': 'الإدارة',
  'nav.recruiter': 'التوظيف',
  'nav.employee': 'مساحتي',
  'nav.notifications': 'الإشعارات',
  'nav.signOut': 'تسجيل الخروج',
  'nav.language': 'English',
  'login.title': 'سجّل الدخول إلى مساحة عملك',
  'login.email': 'البريد الإلكتروني للعمل',
  'login.submit': 'أرسل لي رابط تسجيل الدخول',
  'login.sent': 'تحقق من بريدك: أرسلنا رابط تسجيل دخول صالحًا لمدة 30 دقيقة.',
  'common.loading': 'جارٍ التحميل…',
  'common.error': 'حدث خطأ. يُرجى المحاولة مرة أخرى.',
  'common.save': 'حفظ',
  'common.create': 'إنشاء',
  'runner.start': 'ابدأ التقييم',
  'runner.submit': 'إرسال التقييم',
  'runner.saved': 'تم حفظ جميع الإجابات',
  'runner.saving': 'جارٍ الحفظ…',
  'runner.offline': 'أنت غير متصل. إجاباتك محفوظة على هذا الجهاز وسيتم إرسالها عند إعادة الاتصال.',
  'runner.timeLeft': 'الوقت المتبقي',
  'runner.done': 'تم إرسال إجاباتك. يمكنك إغلاق هذه النافذة.',
};

const catalogues: Record<Locale, Record<MessageKey, string>> = { en, ar };

export function isLocale(v: string | undefined): v is Locale {
  return v === 'en' || v === 'ar';
}

export function dirOf(locale: Locale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

export function translate(locale: Locale, key: MessageKey): string {
  return catalogues[locale][key];
}
