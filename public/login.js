const form = document.querySelector('#loginForm');
const err = document.querySelector('#err');
const btn = document.querySelector('#submitBtn');

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
