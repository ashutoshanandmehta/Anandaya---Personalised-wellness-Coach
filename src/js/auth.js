import { apiClient } from './apiClient.js';
import { loadApp } from './app.js';

export function initAuth() {
  const authShell = document.getElementById('authShell');
  const mainAppLayout = document.getElementById('mainAppLayout');
  const emptyStateShell = document.getElementById('emptyStateShell');
  const appHeader = document.getElementById('app-header');

  // Forms
  const loginForm = document.getElementById('loginForm');
  const loginEmail = document.getElementById('loginEmail');
  const loginPassword = document.getElementById('loginPassword');
  const loginError = document.getElementById('loginError');
  const loginSubmitBtn = document.getElementById('loginSubmitBtn');

  const signupEmailForm = document.getElementById('signupEmailForm');
  const signupEmail = document.getElementById('signupEmail');
  const signupEmailError = document.getElementById('signupEmailError');

  const signupOtpForm = document.getElementById('signupOtpForm');
  const signupOtp = document.getElementById('signupOtp');
  const signupOtpError = document.getElementById('signupOtpError');
  const displayOtpEmail = document.getElementById('displayOtpEmail');
  const otpExpiryTimer = document.getElementById('otpExpiryTimer');
  const resendOtpBtn = document.getElementById('resendOtpBtn');

  const signupPasswordForm = document.getElementById('signupPasswordForm');
  const signupPassword = document.getElementById('signupPassword');
  const signupPasswordError = document.getElementById('signupPasswordError');

  const forgotPwEmailForm = document.getElementById('forgotPwEmailForm');
  const forgotPwEmail = document.getElementById('forgotPwEmail');
  const forgotPwEmailError = document.getElementById('forgotPwEmailError');

  const forgotPwOtpForm = document.getElementById('forgotPwOtpForm');
  const forgotPwOtp = document.getElementById('forgotPwOtp');
  const forgotPwNewPassword = document.getElementById('forgotPwNewPassword');
  const forgotPwOtpError = document.getElementById('forgotPwOtpError');

  // Nav links
  document.getElementById('linkToSignup').addEventListener('click', (e) => {
    e.preventDefault(); showForm(signupEmailForm);
  });
  document.getElementById('linkToForgotPw').addEventListener('click', (e) => {
    e.preventDefault(); showForm(forgotPwEmailForm);
  });
  document.getElementById('linkToLoginFromSignup').addEventListener('click', (e) => {
    e.preventDefault(); showForm(loginForm);
  });
  document.getElementById('linkToLoginFromForgot').addEventListener('click', (e) => {
    e.preventDefault(); showForm(loginForm);
  });

  // State
  let currentSignupEmail = '';
  let currentFlow = 'signup';
  let otpInterval;

  // Global auth event
  window.addEventListener('auth:unauthorized', showAuthShellFn);

  // ── Utils ──
  function showForm(formEl) {
    [loginForm, signupEmailForm, signupOtpForm, signupPasswordForm, forgotPwEmailForm, forgotPwOtpForm]
      .forEach(f => f.classList.add('hidden'));
    formEl.classList.remove('hidden');
    clearErrors();
  }

  function clearErrors() {
    [loginError, signupEmailError, signupOtpError, signupPasswordError, forgotPwEmailError, forgotPwOtpError]
      .forEach(el => { el.textContent = ''; el.style.display = 'none'; });
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.style.display = 'block';
  }

  function showAuthShellFn() {
    authShell.classList.remove('hidden');
    mainAppLayout.classList.add('hidden');
    emptyStateShell.classList.add('hidden');
    appHeader.classList.add('hidden');
    showForm(loginForm);
  }

  function startOtpTimers() {
    clearInterval(otpInterval);
    resendOtpBtn.disabled = true;

    let expirySecs = 300;
    let resendSecs = 30;

    otpInterval = setInterval(() => {
      expirySecs--;
      resendSecs--;

      if (resendSecs <= 0) {
        resendOtpBtn.disabled = false;
        resendOtpBtn.textContent = 'Resend code';
      } else {
        resendOtpBtn.textContent = `Resend code (${resendSecs}s)`;
      }

      if (expirySecs <= 0) {
        clearInterval(otpInterval);
        otpExpiryTimer.textContent = 'Expired';
        otpExpiryTimer.classList.add('expired');
      } else {
        const m = Math.floor(expirySecs / 60).toString().padStart(2, '0');
        const s = (expirySecs % 60).toString().padStart(2, '0');
        otpExpiryTimer.textContent = `${m}:${s}`;
        otpExpiryTimer.classList.remove('expired');
      }
    }, 1000);
  }

  // ── Handlers ──

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginSubmitBtn.disabled = true;
    loginSubmitBtn.textContent = 'Signing in…';
    try {
      await apiClient.post('/api/auth/login', {
        email: loginEmail.value.trim(),
        password: loginPassword.value
      });
      await loadApp();
    } catch (error) {
      showError(loginError, error.message);
    } finally {
      loginSubmitBtn.disabled = false;
      loginSubmitBtn.textContent = 'Sign in';
    }
  });

  signupEmailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('signupEmailBtn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      currentSignupEmail = signupEmail.value.trim();
      currentFlow = 'signup';
      await apiClient.post('/api/auth/request-otp', { email: currentSignupEmail, purpose: 'signup' });
      displayOtpEmail.textContent = currentSignupEmail;
      showForm(signupOtpForm);
      startOtpTimers();
    } catch (error) {
      showError(signupEmailError, error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send verification code';
    }
  });

  resendOtpBtn.addEventListener('click', async () => {
    resendOtpBtn.disabled = true;
    resendOtpBtn.textContent = 'Sending…';
    try {
      await apiClient.post('/api/auth/request-otp', { email: currentSignupEmail, purpose: currentFlow });
      startOtpTimers();
    } catch (error) {
      alert(error.message);
      resendOtpBtn.disabled = false;
    }
  });

  signupOtpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('signupOtpBtn');
    btn.disabled = true;
    try {
      await apiClient.post('/api/auth/verify-otp', {
        email: currentSignupEmail, purpose: 'signup', otp: signupOtp.value.trim()
      });
      showForm(signupPasswordForm);
    } catch (error) {
      showError(signupOtpError, error.message);
    } finally {
      btn.disabled = false;
    }
  });

  signupPasswordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('signupPasswordBtn');
    btn.disabled = true;
    try {
      await apiClient.post('/api/auth/signup', {
        email: currentSignupEmail,
        otp: signupOtp.value.trim(),
        password: signupPassword.value
      });
      await loadApp();
    } catch (error) {
      showError(signupPasswordError, error.message);
    } finally {
      btn.disabled = false;
    }
  });

  forgotPwEmailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('forgotPwEmailBtn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      currentSignupEmail = forgotPwEmail.value.trim();
      currentFlow = 'forgot-password';
      await apiClient.post('/api/auth/request-otp', { email: currentSignupEmail, purpose: 'forgot-password' });
      showForm(forgotPwOtpForm);
      startOtpTimers();
    } catch (error) {
      showError(forgotPwEmailError, error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send reset code';
    }
  });

  forgotPwOtpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('forgotPwSubmitBtn');
    btn.disabled = true;
    try {
      await apiClient.post('/api/auth/forgot-password/reset', {
        email: currentSignupEmail,
        otp: forgotPwOtp.value.trim(),
        newPassword: forgotPwNewPassword.value
      });
      alert('Password reset successful. Please sign in.');
      showForm(loginForm);
      loginEmail.value = currentSignupEmail;
    } catch (error) {
      showError(forgotPwOtpError, error.message);
    } finally {
      btn.disabled = false;
    }
  });

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await apiClient.post('/api/auth/logout'); } catch {}
    window.location.reload();
  });
}
