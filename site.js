/* =============================================
   CONFIGURATION
   ============================================= */
const SUPABASE_URL      = 'https://sdltggiedqstrsnvvjmj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkbHRnZ2llZHFzdHJzbnZ2am1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NjM0NDAsImV4cCI6MjA5MTEzOTQ0MH0.20Z2gkI2V50BOXdVwFuvm4SjPVVgP9QGdjNH7BLqCkI';
const PAGE_SIZE = 8;

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
const logoutBtn      = document.getElementById('logout-btn');
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

      canvas.toBlob(
        blob => resolve(blob),
        'image/webp',
        0.7
      );
    };

    img.src = URL.createObjectURL(file);
  });
}

async function uploadImageToSupabase(blob) {
  const fileName = `post-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;

  const { error } = await db.storage
    .from('posts')
    .upload(fileName, blob, {
      contentType: 'image/webp'
    });

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
      // Optional: temporary placeholder (UX boost)
      const range = quill.getSelection();
      quill.insertText(range.index, 'Uploading image...\n');

      // 1. Compress → Blob
      const blob = await compressImageToBlob(file);

      // 2. Upload → Supabase
      const publicUrl = await uploadImageToSupabase(blob);

      // 3. Replace placeholder with image
      const currentRange = quill.getSelection();
      quill.deleteText(currentRange.index - 1, 1); // remove "Uploading..."

      quill.insertEmbed(currentRange.index, 'image', publicUrl);

    } catch (err) {
      console.error('Image upload failed:', err);
      alert('Image upload failed');
    }
  };
}

/* Auto-embed YouTube links pasted into editor */
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
   Inject an email field above the existing
   password field — no HTML changes needed.
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

/* Open modal */
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

  authConfirm.disabled     = true;
  authConfirm.textContent  = 'Signing in…';
  authError.classList.add('hidden');

  try {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    // onAuthStateChange handles the rest
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
  // onAuthStateChange handles the rest
}

logoutBtn.addEventListener('click', logoutAdmin);

/* =============================================
   SESSION LISTENER
   Single source of truth for admin state.
   Fires on page load (restores session from
   localStorage automatically) and on any
   sign-in / sign-out event.
   ============================================= */
db.auth.onAuthStateChange((_event, session) => {
  const wasAdmin = isAdmin;
  isAdmin = !!session;

  editorSection.classList.toggle('hidden', !isAdmin);
  adminBtn.title        = isAdmin ? 'Exit admin' : 'Admin';
  adminBtn.style.color  = isAdmin ? '#111' : '';
  adminBtn.style.opacity = isAdmin ? '1' : '';

  // Only re-render cards if the admin state actually changed
  if (wasAdmin !== isAdmin) reRenderCurrentPosts();
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

// function cleanYouTubeEmbeds(html) {
//   return html.replace(
//     /https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/g,
//     (_, __, ___, id) =>
//       `<iframe src="https://www.youtube.com/embed/${id}" frameborder="0" allowfullscreen style="width:100%;height:400px;"></iframe>`
//   );
// }

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
  publishBtn.disabled = true;
  publishBtn.textContent = editId ? 'Saving…' : 'Publishing…';

  try {
    if (editId) {
      // UPDATE existing post
  console.log('Editing post ID:', editId);
  console.log('Content length:', content.length);
  console.log('Tags:', currentTags);

  const { data, error } = await db.from('posts').update({
    content,
    tags: currentTags,
  }).eq('id', editId).select();

  console.log('Update result - data:', data);
  console.log('Update result - error:', error);

  if (error) throw error;
  delete publishBtn.dataset.editId;
    } else {
      // INSERT new post
      const { error } = await db.from('posts').insert([{
        content,
        tags: currentTags,
        created_at: new Date().toISOString()
      }]).select().single();
      if (error) throw error;

      const postTitle = quill.getText().trim().split('\n')[0].slice(0, 80) || 'New post';
      await notifySubscribers(postTitle, quill.root.innerHTML);
    }

    quill.setText('');
    currentTags = [];
    renderTagPills();
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
   FETCH POSTS
   ============================================= */
async function fetchPosts(offset, limit = PAGE_SIZE) {
  let query = db
    .from('posts')
    .select('*')
    .order('created_at', { ascending: false });

  if (activeTagFilter) {
    query = query.contains('tags', [activeTagFilter]);
  }

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
    newPosts.forEach(post => postsFeed.appendChild(buildPostCard(post)));

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
   RE-RENDER (used when toggling admin mode)
   ============================================= */
function reRenderCurrentPosts() {
  postsFeed.innerHTML = '';
  loadedPosts.forEach(post => postsFeed.appendChild(buildPostCard(post)));
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

  let metaHtml = `<div class="post-meta"><span class="post-date">${dateStr}</span>`;
  tags.forEach(tag => {
    const isActive = tag === activeTagFilter;
    metaHtml += `<button class="post-tag${isActive ? ' active' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;
  });
  metaHtml += `</div>`;

  let bodyHtml = post.content || '';
  bodyHtml = optimizeImages(bodyHtml);
  if (searchQuery) bodyHtml = highlightText(bodyHtml, searchQuery);

  const adminBar = isAdmin
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
  // Scroll to editor and populate it
  editorSection.classList.remove('hidden');
  editorSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Load content into Quill
  quill.root.innerHTML = post.content || '';

  // Load tags
  currentTags = Array.isArray(post.tags) ? [...post.tags] : [];
  renderTagPills();

  // Swap Publish button to Save
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

// ---- SUBSCRIBE ----
document.getElementById('subscribe-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('sub-email').value.trim();
  const msg   = document.getElementById('sub-msg');
  const btn   = e.target.querySelector('button[type="submit"]');

  btn.disabled = true;
  msg.textContent = 'Subscribing…';

  const { error } = await db         
    .from('subscribers')
    .insert([{ email }]);

  if (error) {
    msg.textContent = error.code === '23505'
      ? 'You\'re already subscribed!'
      : 'Something went wrong. Try again.';
  } else {
    msg.textContent = '✓ You\'re subscribed!';
    document.getElementById('sub-email').value = '';
  }

  btn.disabled = false;
});

// ---- NOTIFY ON PUBLISH ----
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
/* =============================================
   INIT
   ============================================= */
applyFilters();