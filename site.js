/* =============================================
   CONFIGURATION
   ============================================= */
const SUPABASE_URL      = 'https://sdltggiedqstrsnvvjmj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkbHRnZ2llZHFzdHJzbnZ2am1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NjM0NDAsImV4cCI6MjA5MTEzOTQ0MH0.20Z2gkI2V50BOXdVwFuvm4SjPVVgP9QGdjNH7BLqCkI';
const PAGE_SIZE = 8;
const AI_COMMENT_DELAY_MS = 1000; // 1 second

/* =============================================
   SUPABASE CLIENT
   ============================================= */
const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* =============================================
   STATE
   ============================================= */
let isAdmin       = false;
let loadedPosts   = [];
let hasMorePosts  = true;
let currentTags   = [];
let activeTagFilter = null;
let searchQuery   = '';
let personalities = [];
let personalityMap = {};
let currentUsername = '';

/* =============================================
   LOAD PERSONALITIES
   ============================================= */
async function loadPersonalities() {
  try {
    personalities = window.personalities || [];

    // build fast lookup map: name → full persona object
    personalityMap = Object.fromEntries(
      personalities.map(p => [p.name, p])
    );

  } catch (err) {
    console.error('Could not load personalities:', err);
    personalities = [];
    personalityMap = {};
  }
}
/* =============================================
   DOM REFS
   ============================================= */
const adminBtn       = document.getElementById('admin-btn');
const authModal      = document.getElementById('auth-modal');
const adminPassInput = document.getElementById('admin-pass');
const authCancel     = document.getElementById('auth-cancel');
const authConfirm    = document.getElementById('auth-confirm');
const authError      = document.getElementById('auth-error');
const editorSection  = document.getElementById('editor-section');
const publishBtn     = document.getElementById('publish-btn');
const tagInput       = document.getElementById('tag-input');
const tagList        = document.getElementById('tag-list');
const postsFeed      = document.getElementById('posts-feed');
const loadMoreBtn    = document.getElementById('load-more-btn');
const noResults      = document.getElementById('no-results');
const searchInput    = document.getElementById('search-input');
const searchClear    = document.getElementById('search-clear');

/* =============================================
   QUILL SETUP
   ============================================= */
const quill = new Quill('#quill-editor', {
  theme: 'snow',
  placeholder: "What's on your mind…",
  modules: {
    toolbar: {
      container: [
        [{ header: [2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        ['blockquote', 'code-block'],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['link', 'image', 'video'],
        ['clean']
      ],
      handlers: {
        image: imageHandler
      }
    }
  }
});

/* =============================================
   DRAFT AUTOSAVE
   ============================================= */
const DRAFT_KEY = 'blog_draft';
let draftTimer;

function saveDraft() {
  const content = quill.root.innerHTML;
  const text = quill.getText().trim();
  const hasContent = text || quill.getContents().ops.some(op => op.insert && typeof op.insert === 'object');

  if (!hasContent) {
    clearDraft();
    return;
  }

  const draft = {
    content,
    tags: [...currentTags],
    savedAt: new Date().toISOString()
  };
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

function restoreDraft() {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return;

  try {
    const draft = JSON.parse(raw);
    if (!draft.content) return;

    quill.root.innerHTML = draft.content;
    currentTags = draft.tags || [];
    renderTagPills();
  } catch (e) {
    console.warn('Failed to restore draft:', e);
    localStorage.removeItem(DRAFT_KEY);
  }
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

quill.on('text-change', () => {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 5000);
});

async function compressImageToBlob(file) {
  const img = new Image();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  return new Promise(resolve => {
    img.onload = () => {
      const MAX_WIDTH = 900;
      let width = img.width;
      let height = img.height;
      if (width > MAX_WIDTH) {
        height *= MAX_WIDTH / width;
        width = MAX_WIDTH;
      }
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(img.src);
      canvas.toBlob(blob => resolve(blob), 'image/webp', 0.7);
    };
    img.src = URL.createObjectURL(file);
  });
}

async function uploadImageToSupabase(blob) {
  const fileName = `post-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;
  const { error } = await db.storage.from('posts').upload(fileName, blob, { contentType: 'image/webp' });
  if (error) throw error;
  return `${SUPABASE_URL}/storage/v1/object/public/posts/${fileName}`;
}

async function imageHandler() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.click();
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const range = quill.getSelection(true);
      const placeholderText = 'Uploading image...\n';
      quill.insertText(range.index, placeholderText, 'user');
      quill.setSelection(range.index + placeholderText.length);

      const blob = await compressImageToBlob(file);
      const publicUrl = await uploadImageToSupabase(blob);

      // Delete the placeholder text precisely
      quill.deleteText(range.index, placeholderText.length);
      quill.insertEmbed(range.index, 'image', publicUrl);
      quill.setSelection(range.index + 1);
    } catch (err) {
      console.error('Image upload failed:', err);
      alert('Image upload failed');
    }
  };
}

quill.clipboard.addMatcher(Node.TEXT_NODE, (node, delta) => {
  const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/g;
  const text = node.data;
  let match, lastIndex = 0;
  const ops = [];
  while ((match = ytRegex.exec(text)) !== null) {
    if (match.index > lastIndex) ops.push({ insert: text.slice(lastIndex, match.index) });
    ops.push({ insert: { video: `https://www.youtube.com/embed/${match[1]}` } });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) ops.push({ insert: text.slice(lastIndex) });
  if (ops.length > 0) {
    const newDelta = new quill.constructor.imports['delta']();
    ops.forEach(op => newDelta.push(op));
    return newDelta;
  }
  return delta;
});

/* =============================================
   AUTH MODAL
   ============================================= */
const emailField = document.createElement('input');
emailField.id    = 'admin-email';
emailField.type  = 'email';
emailField.placeholder = 'Email';
emailField.autocomplete = 'email';
emailField.style.cssText = `
  width:100%; border:1px solid #d0d0d0; border-radius:8px;
  padding:.5rem .85rem; font-family:inherit; font-size:.95rem;
  outline:none; margin-bottom:.5rem; display:block;
  transition:box-shadow 180ms ease;
`;
emailField.addEventListener('focus', () => emailField.style.boxShadow = '0 0 0 2px #1a1a1a22');
emailField.addEventListener('blur',  () => emailField.style.boxShadow = '');
adminPassInput.parentNode.insertBefore(emailField, adminPassInput);

adminBtn.addEventListener('click', () => {
  if (isAdmin) { logoutAdmin(); return; }
  emailField.value      = '';
  adminPassInput.value  = '';
  authError.classList.add('hidden');
  authModal.classList.remove('hidden');
  setTimeout(() => emailField.focus(), 50);
});

authCancel.addEventListener('click', closeAuthModal);
authConfirm.addEventListener('click', attemptLogin);

emailField.addEventListener('keydown', e => {
  if (e.key === 'Enter')  adminPassInput.focus();
  if (e.key === 'Escape') closeAuthModal();
});
adminPassInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  attemptLogin();
  if (e.key === 'Escape') closeAuthModal();
});
authModal.addEventListener('click', e => { if (e.target === authModal) closeAuthModal(); });

function closeAuthModal() {
  authModal.classList.add('hidden');
}

async function attemptLogin() {
  const email    = emailField.value.trim();
  const password = adminPassInput.value;
  if (!email || !password) {
    authError.textContent = 'Please enter your email and password.';
    authError.classList.remove('hidden');
    return;
  }
  authConfirm.disabled    = true;
  authConfirm.textContent = 'Signing in…';
  authError.classList.add('hidden');
  try {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    closeAuthModal();
  } catch {
    authError.textContent = 'Incorrect email or password.';
    authError.classList.remove('hidden');
    adminPassInput.value = '';
    adminPassInput.focus();
  } finally {
    authConfirm.disabled    = false;
    authConfirm.textContent = 'Enter';
  }
}

async function logoutAdmin() {
  await db.auth.signOut();
}

db.auth.onAuthStateChange((_event, session) => {
  const wasAdmin = isAdmin;
  isAdmin = !!session;
  currentUsername = session?.user?.email?.split('@')[0] || '';
  editorSection.classList.toggle('hidden', !isAdmin);
  adminBtn.textContent = isAdmin ? 'Sign out' : 'Sign in';
  adminBtn.title        = isAdmin ? 'Sign out' : 'Sign in';
  if (wasAdmin !== isAdmin) reRenderCurrentPosts();
  // Restore draft when signing in
  if (isAdmin && !wasAdmin) restoreDraft();
});

/* =============================================
   TAG INPUT
   ============================================= */
tagInput.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ',') && tagInput.value.trim()) {
    e.preventDefault();
    addTag(tagInput.value.trim().replace(/,/g, '').toLowerCase());
    tagInput.value = '';
  }
  if (e.key === 'Backspace' && !tagInput.value && currentTags.length > 0) {
    removeTag(currentTags[currentTags.length - 1]);
  }
});

function addTag(tag) {
  if (!tag || currentTags.includes(tag)) return;
  currentTags.push(tag);
  renderTagPills();
}

function removeTag(tag) {
  currentTags = currentTags.filter(t => t !== tag);
  renderTagPills();
}

function renderTagPills() {
  tagList.innerHTML = '';
  currentTags.forEach(tag => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.innerHTML = `${escapeHtml(tag)}<button class="tag-remove" data-tag="${escapeHtml(tag)}" title="Remove">&#10005;</button>`;
    pill.querySelector('.tag-remove').addEventListener('click', () => removeTag(tag));
    tagList.appendChild(pill);
  });
}

function cleanYouTubeEmbeds(html) {
  return html.replace(
    /https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/g,
    (_, __, ___, id) => {
      return `<iframe
        width="100%"
        height="400"
        src="https://www.youtube.com/embed/${id}"
        title="YouTube video player"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        referrerpolicy="strict-origin-when-cross-origin"
        allowfullscreen
        style="width:100%; height:400px; max-width:100%; border-radius:8px;">
      </iframe>`;
    }
  );
}

/* =============================================
   COOLDOWN MODAL
   ============================================= */
const cooldownModal   = document.getElementById('cooldown-modal');
const cooldownSeconds = document.getElementById('cooldown-seconds');
const cooldownClose   = document.getElementById('cooldown-close');
const cooldownRingFill = document.getElementById('cooldown-ring-fill');

const COOLDOWN_MS = 8 * 60 * 1000; // 8 minutes
const RING_CIRCUMFERENCE = 2 * Math.PI * 18; // r=18

let cooldownInterval = null;

cooldownClose.addEventListener('click', closeCooldownModal);
cooldownModal.addEventListener('click', e => { if (e.target === cooldownModal) closeCooldownModal(); });

function closeCooldownModal() {
  cooldownModal.classList.add('hidden');
  if (cooldownInterval) { clearInterval(cooldownInterval); cooldownInterval = null; }
}

function openCooldownModal(msRemaining) {
  cooldownModal.classList.remove('hidden');

  function tick() {
    const secs = Math.ceil(msRemaining / 1000);
    if (secs <= 0) { closeCooldownModal(); return; }

    const mins = Math.floor(secs / 60);
    const s    = secs % 60;
    cooldownSeconds.textContent = `${mins}:${String(s).padStart(2, '0')}`;

    // Arc: full at start → empty at 0
    const progress = msRemaining / COOLDOWN_MS;
    const dashOffset = RING_CIRCUMFERENCE * (1 - progress);
    cooldownRingFill.style.strokeDashoffset = dashOffset;

    msRemaining -= 1000;
  }

  tick();
  cooldownInterval = setInterval(tick, 1000);
}

async function checkCooldown() {
  const { data, error } = await db
    .from('posts')
    .select('created_at')
    .eq('author', currentUsername)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return 0; // no previous post → no cooldown

  const elapsed = Date.now() - new Date(data.created_at).getTime();
  const remaining = COOLDOWN_MS - elapsed;
  return remaining > 0 ? remaining : 0;
}


/* =============================================
   PUBLISH
   ============================================= */
publishBtn.addEventListener('click', async () => {
  let content = quill.root.innerHTML;
  content = cleanYouTubeEmbeds(content);
  const text = quill.getText().trim();
  if (!text && !quill.getContents().ops.some(op => op.insert && typeof op.insert === 'object')) {
    quill.root.focus();
    return;
  }

  const editId = publishBtn.dataset.editId;
  // Cooldown check only applies to new posts, not edits
  if (!editId) {
    const remaining = await checkCooldown();
    if (remaining > 0) {
      openCooldownModal(remaining);
      return;
    }
  }
  publishBtn.disabled = true;
  publishBtn.textContent = editId ? 'Saving…' : 'Publishing…';

  try {
    if (editId) {
      const { error } = await db.from('posts').update({
        content,
        tags: currentTags,
      }).eq('id', editId);
      if (error) throw error;
      delete publishBtn.dataset.editId;
    } else {
      const { data: insertedPost, error } = await db.from('posts').insert([{
        content,
        tags: currentTags,
        author: currentUsername, 
        created_at: new Date().toISOString()
      }]).select().single();
      if (error) throw error;

      const postTitle = quill.getText().trim().split('\n')[0].slice(0, 80) || 'New post';
      await notifySubscribers(postTitle, quill.root.innerHTML);

      scheduleAIComments(insertedPost.id, content);
    }

    quill.setText('');
    currentTags = [];
    renderTagPills();
    clearDraft();
    await applyFilters();

  } catch (err) {
    console.error('Publish error:', err);
    alert('Failed to save.\n' + err.message);
  } finally {
    publishBtn.disabled = false;
    publishBtn.textContent = 'Publish';
  }
});

/* =============================================
   AI COMMENTS
   ============================================= */

/**
 * Strip HTML tags from content so the AI reads plain text.
 */
function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

/**
 * Save a comment to Supabase.
 */
async function saveComment(postId, persona, content) {
  const { error } = await db.from('comments').insert([{
    post_id: postId,
    persona_name: persona.name,
    persona_color: persona.color,
    content,
    created_at: new Date().toISOString()
  }]);
  if (error) throw error;
}

/**
 * Schedule AI comments to fire after publish.
 * Each persona comments in sequence with a small stagger.
 */
function extractImagesFromHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return [...div.querySelectorAll('img')]
    .map(img => img.src)
    .filter(src => src && src.startsWith('http'));
}

async function generateAICommentsBatch(postText, personas, imageUrls = []) {
  const res = await fetch(
    'https://sdltggiedqstrsnvvjmj.supabase.co/functions/v1/ai-comment',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        postText,
        personas,
        imageUrls
      }),
    }
  );

  const data = await res.json();
  return data.comments || [];
}

function scheduleAIComments(postId, postHtml) {
  if (!personalities.length) return;

  setTimeout(async () => {
    const postText = stripHtml(postHtml);
    const imageUrls = extractImagesFromHtml(postHtml);

    // Remove any regenerate button that appeared during re-render
    const card = document.querySelector(`#posts-feed [data-id="${postId}"]`);
    card?.querySelector('.btn-regenerate')?.remove();

    showCommentsStatus(postId, 'loading');

    try {
      const comments = await generateAICommentsBatch(postText, personalities, imageUrls);

      if (!comments.length) throw new Error('No comments returned');

      // Insert all comments to DB in one batch
      const rows = comments.map(c => ({
        post_id: postId,
        persona_name: c.name,
        persona_color: personalities.find(p => p.name === c.name)?.color || '#000',
        content: c.comment,
        created_at: new Date().toISOString()
      }));

      const { error } = await db.from('comments').insert(rows);
      if (error) throw error;

      hideCommentsStatus(postId);

      // Display comments with a small visual stagger
      for (const c of comments) {
        appendCommentToCard(postId, {
          persona_name: c.name,
          persona_color: personalities.find(p => p.name === c.name)?.color || '#000',
          content: c.comment,
          created_at: new Date().toISOString()
        });
        await new Promise(r => setTimeout(r, 300));
      }

    } catch (err) {
      console.error("[AI batch failed]", err);
      hideCommentsStatus(postId);
      showCommentsStatus(postId, 'error');
      // Show regenerate button after failure
      showRegenerateButton(postId, postHtml);
    }
  }, AI_COMMENT_DELAY_MS);
}


function showCommentsStatus(postId, state) {
  const card = document.querySelector(`#posts-feed [data-id="${postId}"]`);
  if (!card) return;

  hideCommentsStatus(postId); // remove any existing

  const el = document.createElement('div');
  el.className = `comments-status comments-status--${state}`;
  el.dataset.statusFor = postId;

  if (state === 'loading') {
    el.innerHTML = `
      <span class="comments-status-spinner"></span>
      <span>AI agents generating comments…</span>
    `;
  } else if (state === 'error') {
    el.innerHTML = `
      <span class="comments-status-icon">✕</span>
      <span>Error while generating comments</span>
    `;
  }

  card.appendChild(el);
}

function hideCommentsStatus(postId) {
  document.querySelectorAll(`[data-status-for="${postId}"]`)
    .forEach(el => el.remove());
}

/* =============================================
   REGENERATE COMMENTS BUTTON
   ============================================= */

/**
 * Show a "Regenerate comments" button on a post card.
 * Only visible to the post owner (admin).
 * Clears existing comments first, then re-runs generation.
 */
function showRegenerateButton(postId, postHtml) {
  // Only show for admins
  if (!isAdmin) return;

  const card = document.querySelector(`#posts-feed [data-id="${postId}"]`);
  if (!card) return;

  // Don't add twice
  if (card.querySelector('.btn-regenerate')) return;

  const btn = document.createElement('button');
  btn.className = 'btn-regenerate';
  btn.title = 'Regenerate AI comments';
  btn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;margin-right:5px;">
      <path d="M13.65 2.35A8 8 0 1 0 15 8h-2a6 6 0 1 1-1.06-3.39L10 6h5V1l-1.35 1.35z" fill="currentColor"/>
    </svg>
    Regenerate comments
  `;

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.innerHTML = `
      <span class="comments-status-spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:5px;"></span>
      Regenerating…
    `;

    try {
      // Delete existing comments from DB for this post
      const { error: delError } = await db.from('comments').delete().eq('post_id', postId);
      if (delError) throw delError;

      // Remove existing comments section from DOM
      const existingSection = card.querySelector('.comments-section');
      const existingToggle  = card.querySelector('.comments-toggle');
      if (existingSection) existingSection.parentElement?.remove();
      else if (existingToggle) existingToggle.parentElement?.remove();

      // Remove the regenerate button itself (scheduleAIComments will re-add if needed)
      btn.remove();

      // Re-run generation immediately (no delay this time)
      const postText  = stripHtml(postHtml);
      const imageUrls = extractImagesFromHtml(postHtml);

      showCommentsStatus(postId, 'loading');

      const comments = await generateAICommentsBatch(postText, personalities, imageUrls);

      if (!comments.length) throw new Error('No comments returned');

      const rows = comments.map(c => ({
        post_id: postId,
        persona_name: c.name,
        persona_color: personalities.find(p => p.name === c.name)?.color || '#000',
        content: c.comment,
        created_at: new Date().toISOString()
      }));

      const { error: insError } = await db.from('comments').insert(rows);
      if (insError) throw insError;

      hideCommentsStatus(postId);

      for (const c of comments) {
        appendCommentToCard(postId, {
          persona_name: c.name,
          persona_color: personalities.find(p => p.name === c.name)?.color || '#000',
          content: c.comment,
          created_at: new Date().toISOString()
        });
        await new Promise(r => setTimeout(r, 300));
      }

    } catch (err) {
      console.error('[Regenerate] failed:', err);
      hideCommentsStatus(postId);
      showCommentsStatus(postId, 'error');
      // Re-enable the button so the user can try again
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;margin-right:5px;">
          <path d="M13.65 2.35A8 8 0 1 0 15 8h-2a6 6 0 1 1-1.06-3.39L10 6h5V1l-1.35 1.35z" fill="currentColor"/>
        </svg>
        Regenerate comments
      `;
      card.appendChild(btn);
    }
  });

  card.appendChild(btn);
}

/**
 * Append a freshly generated comment directly to the visible card
 * without a full re-render (so we don't lose scroll position).
 */
function appendCommentToCard(postId, comment) {
  // Re-query every time in case DOM was rebuilt
  const card = document.querySelector(`#posts-feed [data-id="${postId}"]`);
  if (!card) {
    console.warn(`[AI] Card ${postId} not found in DOM, comment won't appear without refresh`);
    return;
  }

  let section = card.querySelector('.comments-section');
  let toggle = card.querySelector('.comments-toggle');

  if (!section) {
    const wrapper = document.createElement('div');

    toggle = document.createElement('button');
    toggle.className = 'comments-toggle open';
    toggle.innerHTML = `
      <span class="comments-toggle-label">Programs comments</span>
      <span class="comments-toggle-count">(0)</span>
      <span class="comments-toggle-arrow">▼</span>
    `;

    section = document.createElement('div');
    section.className = 'comments-section open';

    toggle.addEventListener('click', () => {
      const isOpen = section.classList.toggle('open');
      toggle.classList.toggle('open', isOpen);
    });

    wrapper.appendChild(toggle);
    wrapper.appendChild(section);
    card.appendChild(wrapper);
  }

  // Update count
  const countEl = card.querySelector('.comments-toggle-count');
  if (countEl) {
    const current = parseInt(countEl.textContent.replace(/\D/g, '')) || 0;
    countEl.textContent = `(${current + 1})`;
  }

  // Open the section so the new comment is visible
  section.classList.add('open');
  if (toggle) toggle.classList.add('open');

  section.appendChild(buildCommentEl(comment));

  // Smooth scroll to the new comment
  section.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* =============================================
   FETCH & RENDER COMMENTS
   ============================================= */
async function fetchComments(postId) {
  const { data, error } = await db
    .from('comments')
    .select('*')
    .eq('post_id', postId)
    .order('created_at', { ascending: true });
  if (error) { console.error('fetchComments error:', error); return []; }
  return data || [];
}

function buildCommentEl(comment) {
  const el = document.createElement('div');
  el.className = 'ai-comment';
  el.style.setProperty('--comment-color', comment.persona_color);

  const dateStr = new Date(comment.created_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  el.innerHTML = `
    <div class="ai-comment-header">
      <span class="ai-comment-name persona-name" data-persona="${escapeHtml(comment.persona_name)}" style="color:${escapeHtml(comment.persona_color)}; cursor:pointer;"> ${escapeHtml(comment.persona_name)}</span>
      <span class="ai-comment-date">${dateStr}</span>
    </div>
    <div class="ai-comment-body">${escapeHtml(comment.content)}</div>
  `;
  return el;
}

async function buildCommentsSection(postId) {
  const comments = await fetchComments(postId);
  if (!comments.length) return null;

  const wrapper = document.createElement('div');

  // Toggle button
  const toggle = document.createElement('button');
  toggle.className = 'comments-toggle';
  toggle.innerHTML = `
    <span class="comments-toggle-label">Programs comments</span>
    <span class="comments-toggle-count">(${comments.length})</span>
    <span class="comments-toggle-arrow">▼</span>
  `;

  // Section
  const section = document.createElement('div');
  section.className = 'comments-section';
  comments.forEach(c => section.appendChild(buildCommentEl(c)));

  toggle.addEventListener('click', () => {
    const isOpen = section.classList.toggle('open');
    toggle.classList.toggle('open', isOpen);
  });

  wrapper.appendChild(toggle);
  wrapper.appendChild(section);
  return wrapper;
}

/* =============================================
   FETCH POSTS
   ============================================= */
async function fetchPosts(offset, limit = PAGE_SIZE) {
  let query = db
    .from('posts')
    .select('*')
    .order('created_at', { ascending: false });

  if (activeTagFilter) query = query.contains('tags', [activeTagFilter]);
  if (searchQuery) {
    const escaped = searchQuery.replace(/[%_]/g, '\\$&');
    query = query.filter('content', 'ilike', `%${escaped}%`);
  }

  const { data, error } = await query.range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}

/* =============================================
   FILTER + SEARCH + PAGINATION
   ============================================= */
async function applyFilters() {
  loadedPosts  = [];
  hasMorePosts = true;
  postsFeed.innerHTML = '';

  const oldBar = document.getElementById('filter-bar');
  if (oldBar) oldBar.remove();

  if (activeTagFilter) {
    const bar = document.createElement('div');
    bar.id = 'filter-bar';
    bar.innerHTML = `
      <span id="filter-label">Filtered by:</span>
      <span class="post-tag active">${escapeHtml(activeTagFilter)}</span>
      <button id="clear-filter">Clear filter</button>`;
    postsFeed.before(bar);
    document.getElementById('clear-filter').addEventListener('click', () => {
      activeTagFilter = null;
      applyFilters();
    });
  }

  noResults.classList.add('hidden');
  loadMoreBtn.classList.add('hidden');
  await loadNextPage(true);
}

async function loadNextPage(isInitial = false) {
  const offset  = loadedPosts.length;
  const loading = document.getElementById('posts-loading');

  if (isInitial) {
    loading.classList.remove('hidden');
  } else {
    loadMoreBtn.textContent = 'Loading…';
    loadMoreBtn.disabled = true;
  }

  try {
    const newPosts = await fetchPosts(offset);

    if (isInitial) loading.classList.add('hidden');
    else { loadMoreBtn.textContent = 'Load more'; loadMoreBtn.disabled = false; }

    if (newPosts.length === 0) {
      if (loadedPosts.length === 0) noResults.classList.remove('hidden');
      hasMorePosts = false;
      loadMoreBtn.classList.add('hidden');
      return;
    }

    loadedPosts.push(...newPosts);

    for (const post of newPosts) {
      const card = buildPostCard(post);
      const commentsSection = await buildCommentsSection(post.id);
      if (commentsSection) card.appendChild(commentsSection);
      postsFeed.appendChild(card); 
      if (!commentsSection && isAdmin && currentUsername === post.author) {
        showRegenerateButton(post.id, post.content || '');
      }
    }

    hasMorePosts = newPosts.length === PAGE_SIZE;
    loadMoreBtn.classList.toggle('hidden', !hasMorePosts);

  } catch (err) {
    console.error('Load error:', err);
    if (isInitial) loading.classList.add('hidden');
    else { loadMoreBtn.textContent = 'Load more'; loadMoreBtn.disabled = false; }
    if (loadedPosts.length === 0) noResults.classList.remove('hidden');
  }
}

/* =============================================
   RE-RENDER
   ============================================= */
async function reRenderCurrentPosts() {
  postsFeed.innerHTML = '';
  for (const post of loadedPosts) {
    const card = buildPostCard(post);
    const commentsSection = await buildCommentsSection(post.id);
    if (commentsSection) card.appendChild(commentsSection);
    postsFeed.appendChild(card); 
    if (!commentsSection && isAdmin && currentUsername === post.author) {
      showRegenerateButton(post.id, post.content || '');
    }
  }
  loadMoreBtn.classList.toggle('hidden', !hasMorePosts);
}

/* =============================================
   BUILD POST CARD
   ============================================= */
function optimizeImages(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('img').forEach(img => {
    img.loading = 'lazy';
    img.decoding = 'async';
    img.style.maxWidth = '100%';
    img.style.borderRadius = '8px';
    img.style.margin = '10px 0';
  });
  return div.innerHTML;
}

function buildPostCard(post) {
  const card = document.createElement('article');
  card.className  = 'post-card';
  card.dataset.id = post.id;

  const dateStr = new Date(post.created_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  const tags = Array.isArray(post.tags) ? post.tags : [];
  const author = post.author || 'anonymous';
  let metaHtml = `
    <div class="post-meta">
      <div class="post-meta-left">
        <span class="post-author">
          <span class="post-author-avatar">${author[0].toUpperCase()}</span>
          ${author}
        </span>
        <span class="post-date">${dateStr}</span>
      </div>
      <div class="post-meta-tags">
  `;
  tags.forEach(tag => {
    const isActive = tag === activeTagFilter;
    metaHtml += `<button class="post-tag${isActive ? ' active' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;
  });
  metaHtml += `</div></div>`;

  let bodyHtml = post.content || '';
  bodyHtml = optimizeImages(bodyHtml);
  if (searchQuery) bodyHtml = highlightText(bodyHtml, searchQuery);

  const isOwner = isAdmin && currentUsername === post.author;

  const adminBar = isOwner
    ? `<div class="post-admin-bar">
        <button class="btn-edit" data-id="${post.id}">Edit post</button>
        <button class="btn-delete" data-id="${post.id}">Delete post</button>
      </div>`
    : '';

  card.innerHTML = metaHtml + `<div class="post-body">${bodyHtml}</div>` + adminBar;

  card.querySelectorAll('.post-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTagFilter = activeTagFilter === btn.dataset.tag ? null : btn.dataset.tag;
      applyFilters();
    });
  });

  card.querySelector('.btn-delete')?.addEventListener('click', () => deletePost(post.id));
  card.querySelector('.btn-edit')?.addEventListener('click', () => editPost(post));

  return card;
}

/* =============================================
   DELETE POST
   ============================================= */
async function deletePost(id) {
  if (!confirm('Delete this post? This cannot be undone.')) return;
  try {
    // Delete associated comments first
    await db.from('comments').delete().eq('post_id', id);
    const { error } = await db.from('posts').delete().eq('id', id);
    if (error) throw error;
    await applyFilters();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

/* =============================================
   EDIT POST
   ============================================= */
async function editPost(post) {
  clearDraft();
  editorSection.classList.remove('hidden');
  editorSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  quill.root.innerHTML = post.content || '';
  currentTags = Array.isArray(post.tags) ? [...post.tags] : [];
  renderTagPills();
  publishBtn.textContent = 'Save changes';
  publishBtn.dataset.editId = post.id;
}

/* =============================================
   LOAD MORE
   ============================================= */
loadMoreBtn.addEventListener('click', () => loadNextPage(false));

/* =============================================
   SEARCH
   ============================================= */
let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = searchInput.value.trim();
    applyFilters();
  }, 280);
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchQuery = '';
  applyFilters();
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { searchInput.value = ''; searchQuery = ''; applyFilters(); }
});

/* =============================================
   UTILITIES
   ============================================= */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightText(html, query) {
  if (!query) return html;
  const div = document.createElement('div');
  div.innerHTML = html;
  walkTextNodes(div, query);
  return div.innerHTML;
}

function walkTextNodes(node, query) {
  if (node.nodeType === Node.TEXT_NODE) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    if (regex.test(node.textContent)) {
      const span = document.createElement('span');
      span.innerHTML = node.textContent.replace(regex, '<mark class="search-highlight">$1</mark>');
      node.parentNode.replaceChild(span, node);
    }
  } else if (node.nodeType === Node.ELEMENT_NODE && !['SCRIPT','STYLE','IFRAME'].includes(node.tagName)) {
    [...node.childNodes].forEach(child => walkTextNodes(child, query));
  }
}

/* =============================================
   SUBSCRIBE
   ============================================= */
document.getElementById('subscribe-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('sub-email').value.trim();
  const msg   = document.getElementById('sub-msg');
  const btn   = e.target.querySelector('button[type="submit"]');

  btn.disabled = true;
  msg.textContent = 'Subscribing…';

  const { error } = await db.from('subscribers').insert([{ email }]);

  if (error) {
    msg.textContent = error.code === '23505'
      ? "You're already subscribed!"
      : 'Something went wrong. Try again.';
  } else {
    msg.textContent = '✓ You\'re subscribed!';
    document.getElementById('sub-email').value = '';
  }

  btn.disabled = false;
});

/* =============================================
   NOTIFY ON PUBLISH
   ============================================= */
async function notifySubscribers(postTitle, postContent) {
  try {
    const res = await fetch('https://sdltggiedqstrsnvvjmj.supabase.co/functions/v1/notify-subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ postTitle, postContent }),
    });
    const text = await res.text();
    console.log('Response status:', res.status);
    console.log('Response body:', text);
  } catch (err) {
    console.error('Failed to notify subscribers:', err);
  }
}


const modal = document.getElementById("persona-modal");
const personaTitle = document.getElementById("persona-title");
const personaText = document.getElementById("persona-text");
const personaClose = document.getElementById("persona-close");
const translateBtn = document.getElementById("translate-btn");
const translationArea = document.getElementById("translation-area");
const personaTranslation = document.getElementById("persona-translation");

document.addEventListener("click", (e) => {
  const el = e.target.closest(".persona-name");
  if (!el) return;

  const name = el.dataset.persona;
  const persona = personalityMap[name];
  if (!persona) return;

  personaTitle.textContent = persona.name;
  personaTitle.style.color = persona.color || '#000';
  personaText.textContent = persona.persona;

  // Store translation on the button, reset state
  translateBtn.dataset.translation = persona.translation || '';
  translateBtn.dataset.translated = 'false';
  translateBtn.textContent = 'Voir en français';
  translateBtn.classList.toggle('hidden', !persona.translation);

  modal.classList.remove("hidden");
});

translateBtn.addEventListener("click", () => {
  const isShowingTranslation = translateBtn.dataset.translated === 'true';

  if (isShowingTranslation) {
    personaText.textContent = translateBtn.dataset.original;
    translateBtn.textContent = 'Voir en français';
    translateBtn.dataset.translated = 'false';
  } else {
    translateBtn.dataset.original = personaText.textContent;
    personaText.textContent = translateBtn.dataset.translation;
    translateBtn.textContent = 'View in english';
    translateBtn.dataset.translated = 'true';
  }
});

personaClose.addEventListener("click", () => modal.classList.add("hidden"));
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });


/* =============================================
   WRITING PROPOSALS
   ============================================= */
const proposalsPanel   = document.getElementById('proposals-panel');
const proposalsLoading = document.getElementById('proposals-loading');
const proposalsContent = document.getElementById('proposals-content');
const proposalsClose   = document.getElementById('proposals-close');
const proposalsHeader  = document.getElementById('proposals-header');

let proposalTimer;

// ── Close button ──
proposalsClose.addEventListener('click', () => {
  proposalsPanel.classList.add('hidden');
});

// ── Drag to reposition ──
let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;

proposalsHeader.addEventListener('mousedown', e => {
  isDragging  = true;
  dragOffsetX = e.clientX - proposalsPanel.getBoundingClientRect().left;
  dragOffsetY = e.clientY - proposalsPanel.getBoundingClientRect().top;
  e.preventDefault();
});

document.addEventListener('mousemove', e => {
  if (!isDragging) return;
  let x = e.clientX - dragOffsetX;
  let y = e.clientY - dragOffsetY;
  // keep inside viewport
  x = Math.max(0, Math.min(x, window.innerWidth  - proposalsPanel.offsetWidth));
  y = Math.max(0, Math.min(y, window.innerHeight - proposalsPanel.offsetHeight));
  proposalsPanel.style.left = x + 'px';
  proposalsPanel.style.top  = y + 'px';
});

document.addEventListener('mouseup', () => { isDragging = false; });

// ── Position popup near cursor ──
function positionNearCursor() {
  const selection = quill.getSelection();
  if (!selection) return;

  const bounds = quill.getBounds(selection.index);
  const editorRect = quill.root.getBoundingClientRect();

  let x = editorRect.left + bounds.left + 12;
  let y = editorRect.top  + bounds.bottom + window.scrollY + 12;

  // flip left if overflows right edge
  if (x + 320 > window.innerWidth) {
    x = window.innerWidth - 320 - 16;
  }

  // flip above cursor if overflows bottom
  const panelHeight = 360;
  if (y + panelHeight > window.innerHeight + window.scrollY) {
    y = editorRect.top + bounds.top + window.scrollY - panelHeight - 8;
  }

  proposalsPanel.style.left = x + 'px';
  proposalsPanel.style.top  = y + 'px';
}

// ── Trigger on ctrl-space pause ──
quill.root.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.code === 'Space') {
    e.preventDefault();
    fetchProposals();
  }
});

const LOCAL_LLM_URL = 'https://t14s.tail03228d.ts.net';
const LOCAL_MODEL   = 'qwen2.5:0.5b'; 

function detectLanguage(text) {
  const sample = text.slice(0, 600).toLowerCase();
  const accents = (sample.match(/[àâäéèêëîïôöùûüçœæ]/g) || []).length;
  const frenchWords = (sample.match(
    /\b(le|la|les|un|une|des|est|sont|dans|pour|avec|sur|pas|que|qui|mais|ou|donc|car|je|tu|il|elle|nous|vous|ils|elles|très|bien|aussi|comme|tout|même|encore|après|avant|sans|depuis|c'est|j'ai|au|du|ce|se|ne|en|et|de|à)\b/gi
  ) || []).length;
  return (accents * 3 + frenchWords) >= 3 ? 'fr' : 'en';
}

function buildPrompt(postText) {
  const lang = detectLanguage(postText);
  const langLine = lang === 'fr'
    ? 'Tu DOIS répondre en français.'
    : 'You MUST reply in English.';

  return `You are a writing assistant. Based on the blog post excerpt below, generate writing proposals.
Return ONLY valid JSON, no markdown, no explanation.
Format: {"completions":["...","..."],"ideas":["...","..."],"questions":["...","..."]}
- completions: 2 short sentence continuations flowing naturally from the last sentence
- ideas: 2 related topic angles the post could explore
- questions: 2 thought-provoking questions a reader might ask
${langLine}

POST:
${postText.slice(-1200)}

JSON:`;
}

  const text = quill.getText().trim();
  if (text.length < 30) return;

  positionNearCursor();
  proposalsPanel.classList.remove('hidden');
  proposalsLoading.classList.remove('hidden');
  proposalsContent.innerHTML = '';

  try {
    const response = await fetch(`${LOCAL_LLM_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LOCAL_MODEL,
        prompt: buildPrompt(text),
        stream: false,
        options: {
          temperature: 0.8,
          num_predict: 400,
          stop: ['\n\n\n'],
        },
      }),
    });

    const data = await response.json();
    const raw = (data.response || '').trim();
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');

    // Robust extraction: parse each array field with regex instead of JSON.parse
    function extractArrayField(json, field) {
      const fieldMatch = json.match(new RegExp(`"${field}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
      if (!fieldMatch) return [];
      // Split on lines that look like quoted strings, handle apostrophes safely
      return [...fieldMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)]
        .map(m => m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\'));
    }

    const jsonStr = match[0];
    renderProposals({
      completions: extractArrayField(jsonStr, 'completions'),
      ideas:       extractArrayField(jsonStr, 'ideas'),
      questions:   extractArrayField(jsonStr, 'questions'),
    });

  } catch (err) {
    console.error('[Proposals] Error:', err);
    const isOffline = err instanceof TypeError || err.message === 'No JSON in response';
    proposalsContent.innerHTML = isOffline
      ? `<div style="text-align:center;padding:1rem 0;">
           <span style="font-size:1.4rem;">📡</span>
           <p style="font-size:.85rem;color:#aaa;margin:.4rem 0 0;">Local server is offline.<br>Proposals unavailable.</p>
         </div>`
      : `<p style="font-size:.8rem;color:#aaa;">Could not load proposals.</p>`;
  } finally {
    proposalsLoading.classList.add('hidden');
  }
}


// ── Render proposals ──
function renderProposals(data) {
  proposalsContent.innerHTML = '';

  const groups = [
    { key: 'completions', label: 'Continue writing', cls: 'proposal-completion', appendable: true },
    { key: 'ideas',       label: 'Ideas to explore', cls: 'proposal-idea',       appendable: false },
    { key: 'questions',   label: 'Reader questions', cls: 'proposal-question',   appendable: false },
  ];

  groups.forEach(({ key, label, cls, appendable }) => {
    const items = data[key];
    if (!items?.length) return;

    const group = document.createElement('div');
    group.className = 'proposal-group';
    group.innerHTML = `<div class="proposal-group-label">${label}</div>`;

    items.forEach(text => {
      const el = document.createElement('div');
      el.className  = `proposal-item ${cls}`;
      el.textContent = text;

      if (appendable) {
        el.title = 'Click to append to your post';
        el.addEventListener('click', () => {
          const length = quill.getLength();
          quill.insertText(length - 1, ' ' + text, 'user');
          quill.setSelection(quill.getLength());
          proposalsPanel.classList.add('hidden');
        });
      }

      group.appendChild(el);
    });

    proposalsContent.appendChild(group);
  });
}


/* =============================================
   LIGHTBOX
   ============================================= */
const lightbox      = document.getElementById('lightbox');
const lightboxImg   = document.getElementById('lightbox-img');
const lightboxClose = document.getElementById('lightbox-close');

function openLightbox(src) {
  lightboxImg.src = src;
  lightbox.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  lightbox.classList.add('hidden');
  lightboxImg.src = '';
  document.body.style.overflow = '';
}

// Close on overlay click or button
lightbox.addEventListener('click', (e) => {
  if (e.target !== lightboxImg) closeLightbox();
});
lightboxClose.addEventListener('click', closeLightbox);

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightbox.classList.contains('hidden')) closeLightbox();
});

// Delegate clicks on post images
document.getElementById('posts-feed').addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG' && e.target.closest('.post-body')) {
    openLightbox(e.target.src);
  }
});

/* =============================================
   INIT
   ============================================= */
loadPersonalities().then(() => applyFilters());