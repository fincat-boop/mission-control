const form = document.querySelector('#loginForm');
const err = document.querySelector('#err');
const btn = document.querySelector('#submitBtn');

// הודעת שגיאה שחזרה מזרימת Google (redirect עם ?error=...)
const ERRORS = {
  not_approved: 'האימייל שלך לא מאושר להתחברות. פנה למנהל המערכת.',
  google: 'ההתחברות דרך Google נכשלה. נסה שוב.',
};
const reason = new URLSearchParams(location.search).get('error');
if (reason) {
  err.textContent = ERRORS[reason] ?? 'ההתחברות נכשלה.';
  history.replaceState(null, '', location.pathname);
}

// כפתור Google מוצג רק אם השרת מוגדר לכך
fetch('/api/auth/config')
  .then((r) => r.json())
  .then(({ google }) => {
    if (google) {
      document.querySelector('#googleBtn').hidden = false;
      document.querySelector('#googleWrap').hidden = false;
    }
  })
  .catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: form.email.value,
        password: form.password.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'ההתחברות נכשלה');
    location.href = '/';
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false;
  }
});
