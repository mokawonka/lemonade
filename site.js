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
let filterVersion = 0;  
let isPrivate = false;
let isSinglePostView = false;

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
        image: imageHandler,
        video: videoHandler 
      }
    }
  }
});

function videoHandler() {
  const tooltip = quill.theme.tooltip;
  const originalSave = tooltip.save.bind(tooltip);
  const originalHide = tooltip.hide.bind(tooltip);

  tooltip.save = function () {
    const url = this.textbox.value;
    const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/);
    if (match) {
      const embedUrl = `https://www.youtube.com/embed/${match[1].slice(0, 11)}`;
      const range = quill.getSelection(true);
      quill.insertEmbed(range.index, 'video', embedUrl, 'user');
      quill.setSelection(range.index + 1);
    }
    tooltip.save = originalSave;
    tooltip.hide = originalHide;
    tooltip.hide();
  };

  tooltip.hide = function () {
    tooltip.save = originalSave;
    tooltip.hide = originalHide;
    originalHide();
  };

  tooltip.edit('video');
  tooltip.textbox.placeholder = 'YouTube URL…';
}

const privateCheckbox = document.getElementById('private-checkbox');
privateCheckbox.addEventListener('change', () => {
  isPrivate = privateCheckbox.checked;
});


/* =============================================
   DRAFT AUTOSAVE
   ============================================= */
const DRAFT_KEY = 'blog_draft';
let draftTimer;

function saveDraft() {
  const text = quill.getText().trim();
  const hasContent = text || quill.getContents().ops.some(op => op.insert && typeof op.insert === 'object');
  
  if (!hasContent) {
    localStorage.removeItem(DRAFT_KEY);
    return;
  }

  const draft = {
    content: quill.root.innerHTML,
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
  const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/g;
  const text = node.data;
  let match, lastIndex = 0;
  const ops = [];
  while ((match = ytRegex.exec(text)) !== null) {
    if (match.index > lastIndex) ops.push({ insert: text.slice(lastIndex, match.index) });
    ops.push({ insert: { video: `https://www.youtube.com/embed/${match[1].slice(0, 11)}` } });
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
  editorSection.classList.toggle('hidden', !isAdmin || isSinglePostView);
  adminBtn.textContent = isAdmin ? 'Sign out' : 'Sign in';
  adminBtn.title        = isAdmin ? 'Sign out' : 'Sign in';
  if (wasAdmin !== isAdmin && !isSinglePostView) applyFilters();
  if (isAdmin && !wasAdmin && !isSinglePostView) restoreDraft();
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
  const div = document.createElement('div');
  div.innerHTML = html;

  // Normalize Quill ql-video iframes
  div.querySelectorAll('iframe.ql-video').forEach(iframe => {
    const src = iframe.getAttribute('src') || '';
    const match = src.match(/youtube\.com\/embed\/([\w-]{11})/);
    if (!match) return;
    iframe.removeAttribute('class');
    iframe.setAttribute('width', '100%');
    iframe.setAttribute('height', '400');
    iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
    iframe.setAttribute('style', 'width:100%;height:400px;max-width:100%;border-radius:8px;display:block;');
  });

  // Convert any remaining bare YouTube URLs (not already in src attributes)
  let result = div.innerHTML;
  result = result.replace(
    /(?<!src=")https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})[^\s"]*/g,
    (_, id) => {
      const cleanId = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 11);
      return `<iframe width="100%" height="400" src="https://www.youtube.com/embed/${cleanId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="width:100%;height:400px;max-width:100%;border-radius:8px;display:block;"></iframe>`;
    }
  );

  return result;
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
        is_private: isPrivate,
        created_at: new Date().toISOString()
      }]).select().single();
      if (error) throw error;

      if (!isPrivate) {
        const postTitle = quill.getText().trim().split('\n')[0].slice(0, 80) || 'New post';
        await notifySubscribers(postTitle, content);
      }

      scheduleAIComments(insertedPost.id, content);
    }

    quill.setText('');
    currentTags = [];
    renderTagPills();
    clearDraft();
    isPrivate = false;
    privateCheckbox.checked = false;
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

/* =============================================
   EXTRACT YOUTUBE URLS FROM POST HTML
   ============================================= */
function extractYouTubeUrlsFromHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  const urls = [];
  div.querySelectorAll('iframe').forEach(iframe => {
    const src = iframe.src || '';
    const match = src.match(/youtube\.com\/embed\/([\w-]{11})/);
    if (match) {
      urls.push(`https://www.youtube.com/watch?v=${match[1]}`);
    }
  });
  return urls;
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

/* =============================================
   AI COMMENTS (with YouTube transcript support)
   ============================================= */
function scheduleAIComments(postId, postHtml) {
  if (!personalities.length) return;

  setTimeout(async () => {
    const card = document.querySelector(`#posts-feed [data-id="${postId}"]`);
    card?.querySelector('.btn-regenerate')?.remove();

    const youtubeUrls = extractYouTubeUrlsFromHtml(postHtml);
    let postText = stripHtml(postHtml);
    const imageUrls = extractImagesFromHtml(postHtml);

    // ── If YouTube video detected, fetch transcript first ──
    if (youtubeUrls.length > 0) {
      showCommentsStatus(postId, 'transcript');

      try {
        const res = await fetch(
          'https://sdltggiedqstrsnvvjmj.supabase.co/functions/v1/get-transcript',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ videoUrl: youtubeUrls[0] }),
          }
        );

        const data = await res.json();

        if (data.transcript) {
          console.log(`[YouTube] Transcript received`);
          postText = `[Video transcript]\n\n${data.transcript}\n\n[Post content]\n${postText}`;
        } else {
          // No transcript available — show message and abort
          hideCommentsStatus(postId);
          showCommentsStatus(postId, 'no-transcript');
          return;
        }

      } catch (err) {
        console.warn('[YouTube] Transcript fetch failed:', err);
        hideCommentsStatus(postId);
        showCommentsStatus(postId, 'no-transcript');
        return;
      }
    }

    // ── Generate AI comments ──
    showCommentsStatus(postId, 'loading');

    try {
      const comments = await generateAICommentsBatch(postText, personalities, imageUrls);

      if (!comments.length) throw new Error('No comments returned');

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
      console.error('[AI batch failed]', err);
      hideCommentsStatus(postId);
      showCommentsStatus(postId, 'error');
      showRegenerateButton(postId, postHtml);
    }
  }, AI_COMMENT_DELAY_MS);
}


function showCommentsStatus(postId, state) {
  const card = document.querySelector(`#posts-feed [data-id="${postId}"]`);
  if (!card) return;

  hideCommentsStatus(postId);

  const el = document.createElement('div');
  el.className = `comments-status comments-status--${state}`;
  el.dataset.statusFor = postId;

  if (state === 'loading') {
    el.innerHTML = `
      <span class="comments-status-spinner"></span>
      <span>AI agents generating comments…</span>
    `;
  } else if (state === 'transcript') {
    el.innerHTML = `
      <span class="comments-status-spinner"></span>
      <span>Generating video transcript…</span>
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
  let baseQuery = db
    .from('posts')
    .select('*')
    .order('created_at', { ascending: false });

  if (activeTagFilter) baseQuery = baseQuery.contains('tags', [activeTagFilter]);
  if (searchQuery) {
    const escaped = searchQuery.replace(/[%_]/g, '\\$&');
    baseQuery = baseQuery.filter('content', 'ilike', `%${escaped}%`);
  }

  if (!isAdmin) {
    // Non-admins: public posts only
    const { data, error } = await baseQuery
      .eq('is_private', false)
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return data || [];
  }

  // Admins: run two queries in parallel and merge
  const [publicRes, privateRes] = await Promise.all([
    baseQuery.eq('is_private', false),
    db.from('posts').select('*')
      .eq('is_private', true)
      .eq('author', currentUsername)
      .order('created_at', { ascending: false })
  ]);

  if (publicRes.error) throw publicRes.error;
  if (privateRes.error) throw privateRes.error;

  // Merge, re-sort by date, deduplicate, then paginate
  const merged = [...(publicRes.data || []), ...(privateRes.data || [])];
  merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const seen = new Set();
  const deduped = merged.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  return deduped.slice(offset, offset + limit);
}

/* =============================================
   FILTER + SEARCH + PAGINATION
   ============================================= */
async function applyFilters() {
  const version = ++filterVersion;  

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
  await loadNextPage(true, version);  
}

async function loadNextPage(isInitial = false, expectedVersion = null) {
  // Ignore stale loads from previous filter changes
  if (expectedVersion !== null && expectedVersion !== filterVersion) {
    return;
  }

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

    // Re-check after the async fetch (this prevents duplicates)
    if (expectedVersion !== null && expectedVersion !== filterVersion) {
      return;
    }

    if (isInitial) loading.classList.add('hidden');
    else {
      loadMoreBtn.textContent = 'Load more';
      loadMoreBtn.disabled = false;
    }

    if (newPosts.length === 0) {
      if (loadedPosts.length === 0) noResults.classList.remove('hidden');
      hasMorePosts = false;
      loadMoreBtn.classList.add('hidden');
      return;
    }

    const prevCount = loadedPosts.length;
    loadedPosts.push(...newPosts);

    // Deduplicate in place
    const seen = new Set();
    loadedPosts = loadedPosts.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    // Render only what's genuinely new after dedup
    const postsToRender = loadedPosts.slice(prevCount);

    for (const post of postsToRender) {
      const card = buildPostCard(post);
      const commentsSection = await buildCommentsSection(post.id);
      if (commentsSection) card.appendChild(commentsSection);
      postsFeed.appendChild(card);
      applyPostTruncation(card);
      if (!commentsSection && isAdmin && currentUsername === post.author) {
        showRegenerateButton(post.id, post.content || '');
      }
    }

    hasMorePosts = newPosts.length === PAGE_SIZE;
    loadMoreBtn.classList.toggle('hidden', !hasMorePosts);

  } catch (err) {
    console.error('Load error:', err);
    if (isInitial) loading.classList.add('hidden');
    else {
      loadMoreBtn.textContent = 'Load more';
      loadMoreBtn.disabled = false;
    }
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
    applyPostTruncation(card);
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

/**
 * Quill stores indented list items as flat <li class="ql-indent-N"> elements.
 * This converts them into proper nested <ul>/<ol> trees so CSS counters work.
 */
function normalizeQuillLists(html) {
  const div = document.createElement('div');
  div.innerHTML = html;

  div.querySelectorAll('ul, ol').forEach(list => {
    const items = [...list.querySelectorAll(':scope > li')];
    if (!items.length) return;

    // Build a nested structure from flat ql-indent-N items
    const root = document.createElement(list.tagName);
    const stack = [root]; // stack[i] = the <ul>/<ol> at depth i

    items.forEach(li => {
      // Determine depth from class (ql-indent-1 → depth 1, none → depth 0)
      const match = [...li.classList].join(' ').match(/ql-indent-(\d+)/);
      const depth = match ? parseInt(match[1]) : 0;

      // Trim stack down to current depth
      while (stack.length > depth + 1) stack.pop();

      // If we need to go deeper, create a new nested list
      while (stack.length < depth + 1) {
        const nested = document.createElement(list.tagName);
        const parent = stack[stack.length - 1];
        const lastLi = parent.lastElementChild;
        if (lastLi) {
          lastLi.appendChild(nested);
        } else {
          parent.appendChild(nested);
        }
        stack.push(nested);
      }

      const cleanLi = li.cloneNode(true);
      cleanLi.classList.remove(...[...cleanLi.classList].filter(c => c.startsWith('ql-indent')));
      stack[stack.length - 1].appendChild(cleanLi);
    });

    list.replaceWith(root);
  });

  return div.innerHTML;
}

function applyPostTruncation(card) {
  const wrap    = card.querySelector('.post-body-wrap');
  const overlay = card.querySelector('.post-fade-overlay');
  const bodyEl  = card.querySelector('.post-body');
  if (!wrap || !overlay || !bodyEl) return;

  const THRESHOLD = 500;

  function check() {
    if (!overlay.isConnected) return;
    if (bodyEl.scrollHeight <= THRESHOLD) {
      overlay.remove();
      wrap.classList.remove('post-body-wrap--collapsible');
    } else {
      wrap.classList.add('post-body-wrap--collapsible');
    }
  }

  // Staggered checks to catch layout settling at different stages
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      check();
      setTimeout(check, 100);
      setTimeout(check, 500);
      setTimeout(check, 1500);
    });
  });

  // Always attach load listeners regardless of img.complete
  // (cached images can have complete=true but layout not yet updated)
  bodyEl.querySelectorAll('img').forEach(img => {
    img.addEventListener('load',  check, { once: true });
    img.addEventListener('error', check, { once: true });

    // Force a reload cycle for already-complete images so layout is guaranteed
    if (img.complete && img.naturalWidth > 0) {
      const src = img.src;
      img.src = '';
      requestAnimationFrame(() => { img.src = src; });
    }
  });
}

function buildPostCard(post) {
  const card = document.createElement('article');
  card.className  = `post-card${post.is_private ? ' post-card--private' : ''}`;
  card.dataset.id = post.id;

  const dateStr = new Date(post.created_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  const tags = Array.isArray(post.tags) ? post.tags : [];
  const author = post.author || 'anonymous';

  const privacyBadge = post.is_private
  ? `<span class="post-private-badge" title="Only visible to you">
       <svg width="10" height="10" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
         <rect x="2" y="5" width="8" height="6" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
         <path d="M4 5V3.5a2 2 0 1 1 4 0V5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
       </svg>
       Private
     </span>`
  : '';

  let metaHtml = `
    <div class="post-meta">
      <div class="post-meta-left">
        <span class="post-author">
          <span class="post-author-avatar">${author[0].toUpperCase()}</span>
          ${author}
        </span>
        <span class="post-date">${dateStr}</span>
        ${privacyBadge}
      </div>
      <div class="post-meta-tags">
  `;
  tags.forEach(tag => {
    const isActive = tag === activeTagFilter;
    metaHtml += `<button class="post-tag${isActive ? ' active' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;
  });
  metaHtml += `</div></div>`;

  let bodyHtml = post.content || '';
  bodyHtml = normalizeQuillLists(bodyHtml);
  bodyHtml = optimizeImages(bodyHtml);
  if (searchQuery) bodyHtml = highlightText(bodyHtml, searchQuery);

  const isOwner = isAdmin && currentUsername === post.author;

  const shareBtn = !post.is_private
    ? `<button class="btn-share" data-id="${post.id}" title="Share post">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="18" cy="5" r="3" stroke="currentColor" stroke-width="1.8"/>
          <circle cx="6" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/>
          <circle cx="18" cy="19" r="3" stroke="currentColor" stroke-width="1.8"/>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        Share
      </button>`
    : '';

  const adminBar = isOwner
    ? `<div class="post-admin-bar">
        ${shareBtn}
        <button class="btn-edit" data-id="${post.id}">Edit post</button>
        <button class="btn-delete" data-id="${post.id}">Delete post</button>
      </div>`
    : shareBtn
      ? `<div class="post-admin-bar">${shareBtn}</div>`
      : '';

  card.innerHTML = metaHtml + `
  <div class="post-body-wrap">
    <div class="post-body">${bodyHtml}</div>
    <div class="post-fade-overlay">
      <button class="post-read-more">Read more</button>
    </div>
  </div>
` + adminBar;

  card.querySelector('.post-read-more')?.addEventListener('click', () => {
    const wrap    = card.querySelector('.post-body-wrap');
    const overlay = card.querySelector('.post-fade-overlay');
    wrap?.classList.remove('post-body-wrap--collapsible');
    overlay?.remove();
  });

  card.querySelectorAll('.post-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTagFilter = activeTagFilter === btn.dataset.tag ? null : btn.dataset.tag;
      applyFilters();
    });
  });

  card.querySelector('.btn-delete')?.addEventListener('click', () => deletePost(post.id));
  card.querySelector('.btn-edit')?.addEventListener('click', () => editPost(post));
  card.querySelector('.btn-share')?.addEventListener('click', () => openShareModal(post.id));


  return card;
}

/* =============================================
   DELETE POST
   ============================================= */
function deletePost(id) {
  const modal   = document.getElementById('delete-modal');
  const confirm = document.getElementById('delete-confirm');
  const cancel  = document.getElementById('delete-cancel');

  modal.classList.remove('hidden');

  function cleanup() {
    modal.classList.add('hidden');
    confirm.removeEventListener('click', onConfirm);
    cancel.removeEventListener('click', onCancel);
    modal.removeEventListener('click', onOverlay);
  }

  async function onConfirm() {
    cleanup();
    try {
      await db.from('comments').delete().eq('post_id', id);
      const { error } = await db.from('posts').delete().eq('id', id);
      if (error) throw error;
      await applyFilters();
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }

  function onCancel()  { cleanup(); }
  function onOverlay(e) { if (e.target === modal) cleanup(); }

  confirm.addEventListener('click', onConfirm);
  cancel.addEventListener('click', onCancel);
  modal.addEventListener('click', onOverlay);
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
loadMoreBtn.addEventListener('click', () => {
  loadNextPage(false, filterVersion);
});

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

searchInput.addEventListener('focus', function () {
  this.removeAttribute('readonly');
}, { once: true });

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
const LOCAL_MODEL   = 'qwen2.5:3b'; 

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

  return `You are a writing assistant. The user is writing and got stuck on the last word — it's a placeholder approximating what they want to say.
  Your job is to replace ONLY that last word or expression with better alternatives that fit naturally.
  Return ONLY valid JSON, no markdown, no explanation.
  Format: {"completions":["...","...","...","..."]}
  - completions: 4 alternatives that replace the last word/expression, keeping the rest of the sentence exactly as-is
  - alternatives should vary in register (formal, casual, precise, metaphorical) but all fit the sentence naturally
  - never complete or extend the sentence, only replace the last word
  ${langLine}

POST:
${postText.slice(-1200)}

JSON:`;
}

async function fetchProposals() {

  const text = quill.getText().trim();

  positionNearCursor();
  proposalsPanel.classList.remove('hidden');
  proposalsLoading.classList.add('hidden');

  if (text.length < 30) {
    proposalsContent.innerHTML = `
      <div style="text-align:center;padding:1rem 0;">
        <span style="font-size:1.4rem;">✍️</span>
        <p style="font-size:.85rem;color:#aaa;margin:.4rem 0 0;">Write a bit more<br>to get suggestions.</p>
      </div>`;
    return;
  }

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
   SHARE MODAL
   ============================================= */
const shareModal     = document.getElementById('share-modal');
const shareModalClose = document.getElementById('share-modal-close');
const shareUrlInput  = document.getElementById('share-url-input');
const shareCopyBtn   = document.getElementById('share-copy-btn');
const shareCopyLabel = document.getElementById('share-copy-label');
const shareCopyIcon  = document.getElementById('share-copy-icon');

shareModalClose.addEventListener('click', closeShareModal);
shareModal.addEventListener('click', e => { if (e.target === shareModal) closeShareModal(); });

function openShareModal(postId) {
  const SITE_BASE = location.hostname === 'mokawonka.github.io'
  ? `${location.origin}/lemonade`
  : location.origin;

  const url = `${SITE_BASE}/post/${postId}`;
  shareUrlInput.value = url;
  shareCopyLabel.textContent = 'Copy';
  shareCopyIcon.innerHTML = `
    <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.7"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  `;
  shareCopyBtn.classList.remove('copied');
  shareModal.classList.remove('hidden');
  setTimeout(() => shareUrlInput.select(), 80);
}

function closeShareModal() {
  shareModal.classList.add('hidden');
}

shareCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareUrlInput.value);
  } catch {
    shareUrlInput.select();
    document.execCommand('copy');
  }
  shareCopyLabel.textContent = 'Copied!';
  shareCopyBtn.classList.add('copied');
  shareCopyIcon.innerHTML = `
    <polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  `;
  setTimeout(() => {
    shareCopyLabel.textContent = 'Copy';
    shareCopyBtn.classList.remove('copied');
    shareCopyIcon.innerHTML = `
      <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.7"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    `;
  }, 2000);
});


/* =============================================
   SINGLE POST VIEW
   ============================================= */
async function renderSinglePost(postId) {
  isSinglePostView = true; 
  // Hide feed UI, show a clean single-post layout
  document.getElementById('editor-section')?.classList.add('hidden');
  document.getElementById('subscribe-section')?.classList.add('hidden');
  document.getElementById('load-more-wrap')?.classList.add('hidden');

  const navbar = document.getElementById('navbar');
  if (navbar) {
    // In renderSinglePost, replace the navbar innerHTML with:
    navbar.querySelector('.nav-right').innerHTML = `
      <a href="${location.origin}/lemonade/" class="btn-ghost btn-sm" style="text-decoration:none;">← All posts</a>
    `;
  }

  const feed = document.getElementById('posts-feed');
  feed.innerHTML = '';

  const loading = document.getElementById('posts-loading');
  loading.classList.remove('hidden');

  try {
    const { data: post, error } = await db
      .from('posts')
      .select('*')
      .eq('id', postId)
      .eq('is_private', false)
      .single();

    loading.classList.add('hidden');

    if (error || !post) {
      feed.innerHTML = `<p style="text-align:center;padding:3rem;color:#aaa;">Post not found.</p>`;
      return;
    }

    const card = buildPostCard(post);

    // Remove truncation — show full post
    card.querySelector('.post-body-wrap')?.classList.remove('post-body-wrap--collapsible');
    card.querySelector('.post-fade-overlay')?.remove();

    // Remove admin bar / share button in single view
    card.querySelector('.post-admin-bar')?.remove();

    feed.appendChild(card);

    // Load comments expanded
    const comments = await fetchComments(postId);
    if (comments.length) {
      const wrapper = document.createElement('div');

      const toggle = document.createElement('button');
      toggle.className = 'comments-toggle open';
      toggle.innerHTML = `
        <span class="comments-toggle-label">Programs comments</span>
        <span class="comments-toggle-count">(${comments.length})</span>
        <span class="comments-toggle-arrow">▼</span>
      `;

      const section = document.createElement('div');
      section.className = 'comments-section open';
      comments.forEach(c => section.appendChild(buildCommentEl(c)));

      toggle.addEventListener('click', () => {
        const isOpen = section.classList.toggle('open');
        toggle.classList.toggle('open', isOpen);
      });

      wrapper.appendChild(toggle);
      wrapper.appendChild(section);
      card.appendChild(wrapper);
    }

  } catch (err) {
    loading.classList.add('hidden');
    console.error('Single post load error:', err);
    feed.innerHTML = `<p style="text-align:center;padding:3rem;color:#aaa;">Failed to load post.</p>`;
  }
}

/* =============================================
   INIT
   ============================================= */
loadPersonalities();

db.auth.getSession().then(() => {
  const redirected = new URLSearchParams(location.search).get('p');
  
  // Check both the ?p= redirect AND location.pathname directly
  const candidates = [
    redirected ? decodeURIComponent(redirected) : null,
    location.pathname,
    location.search  // fallback in case the ID ends up here
  ].filter(Boolean);

  let match = null;
  for (const candidate of candidates) {
    match = candidate.match(/\/post\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    if (match) break;
  }

  if (match) {
    if (redirected) {
      history.replaceState(null, '', '/lemonade/post/' + match[1]);
    }
    renderSinglePost(match[1]);
  } else {
    applyFilters();
  }
});