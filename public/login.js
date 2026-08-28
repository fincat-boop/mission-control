const err = document.querySelector('#err');

// הודעת שגיאה שחזרה מזרימת Google / SSO (redirect עם ?error=...)
const ERRORS = {
  not_approved: 'האימייל שלך לא מאושר להתחברות. פנה למנהל המערכת.',
  google: 'ההתחברות דרך Google נכשלה. נסה שוב.',
  sso: 'הכניסה מ-HUB נכשלה (קישור פג או פסול). נסה שוב מהכפתור ב-HUB.',
};
const reason = new URLSearchParams(location.search).get('error');
if (reason) {
  err.textContent = ERRORS[reason] ?? 'ההתחברות נכשלה.';
  history.replaceState(null, '', location.pathname);
}

// כניסה יחידה היא דרך Google. אם השרת לא מוגדר ל-Google — אין דרך להיכנס,
// ומציגים על כך הודעה במקום כפתור מת.
fetch('/api/auth/config')
  .then((r) => r.json())
  .then(({ google }) => {
    if (!google) {
      document.querySelector('#googleBtn').hidden = true;
      document.querySelector('#googleOff').hidden = false;
    }
  })
  .catch(() => {});
