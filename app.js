const modal = document.querySelector('#modal');
const form = document.querySelector('#authForm');
const title = document.querySelector('#formTitle');
const message = document.querySelector('#formMessage');
const submit = document.querySelector('#submitAuth');
const switchMode = document.querySelector('#switchMode');
let mode = 'register';
function open(modeName) {
  mode = modeName; modal.classList.remove('hidden');
  title.textContent = mode === 'register' ? 'Créer un compte' : 'Connexion';
  form.elements.name.parentElement.classList.toggle('hidden', mode !== 'register');
  form.elements.name.required = mode === 'register';
  form.elements.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  submit.textContent = mode === 'register' ? 'Créer mon compte' : 'Me connecter';
  switchMode.textContent = mode === 'register' ? 'J’ai déjà un compte' : 'Créer un nouveau compte';
  message.textContent = '';
}
document.querySelector('#openLogin').onclick = () => open('login');
document.querySelector('#openRegister').onclick = () => open('register');
document.querySelector('#heroRegister').onclick = () => open('register');
document.querySelector('#closeModal').onclick = () => modal.classList.add('hidden');
modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
switchMode.onclick = () => open(mode === 'register' ? 'login' : 'register');
form.onsubmit = async e => {
  e.preventDefault(); message.textContent = 'Patiente…';
  const body = Object.fromEntries(new FormData(form));
  try {
    const r = await fetch('/api/' + mode, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Une erreur est survenue.');
    location.href = '/dashboard.html';
  } catch (err) { message.textContent = err.message; message.className = 'error'; }
};
document.querySelector('#year').textContent = new Date().getFullYear();
fetch('/api/me').then(r=>r.json()).then(d=>{ if(d.user) location.href='/dashboard.html'; }).catch(()=>{});
