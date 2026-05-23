// ═══════════════════════════════════════════════════════════
// Family App — Service Worker
// Handles scheduled event reminders in the background
// ═══════════════════════════════════════════════════════════
const DB_NAME  = 'familyAppSW';
const DB_VER   = 1;
const STORE    = 'reminders';
const SHOWN    = 'shown';

// ── Open IndexedDB ────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'reminderId' });
      }
      if (!db.objectStoreNames.contains(SHOWN)) {
        db.createObjectStore(SHOWN, { keyPath: 'reminderId' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function dbGet(db, store, key) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

function dbPut(db, store, val) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(val);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

function dbGetAll(db, store) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

function dbDelete(db, store, key) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = e => res();
    req.onerror   = e => rej(e.target.error);
  });
}

function dbClear(db, store) {
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).clear();
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

// ── Install & activate ────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => {
  e.waitUntil(clients.claim());
});

// ── Receive reminders from main thread ────────────────────
self.addEventListener('message', async e => {
  if (e.data?.type === 'SCHEDULE_REMINDERS') {
    const db = await openDB();
    await dbClear(db, STORE);
    for (const r of (e.data.reminders || [])) {
      await dbPut(db, STORE, r);
    }
    // Immediately check if anything is due now or very soon
    await checkAndFire(db);
  }
});

// ── Periodic background sync ──────────────────────────────
self.addEventListener('periodicsync', async e => {
  if (e.tag === 'family-reminders') {
    e.waitUntil((async () => {
      const db = await openDB();
      await checkAndFire(db);
    })());
  }
});

// ── Push messages (fallback for browsers that support it) ─
self.addEventListener('push', async e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'Family App', {
      body: data.body || '',
      icon: data.icon || '/apple-touch-icon.png',
      badge: '/apple-touch-icon.png',
      tag: data.tag || 'family-app',
    })
  );
});

// ── Core: check all reminders and fire due ones ───────────
async function checkAndFire(db) {
  const now       = Date.now();
  const reminders = await dbGetAll(db, STORE);
  const past      = now - 60 * 1000; // don't fire if more than 1 min late

  for (const r of reminders) {
    if (r.fireAt > now) continue;          // not yet due
    if (r.fireAt < now - 30 * 60 * 1000) { // more than 30 min late — skip
      await dbDelete(db, STORE, r.reminderId);
      continue;
    }

    // Check if already shown
    const alreadyShown = await dbGet(db, SHOWN, r.reminderId);
    if (alreadyShown) {
      await dbDelete(db, STORE, r.reminderId);
      continue;
    }

    // Show the notification
    try {
      await self.registration.showNotification(r.title, {
        body:    r.body,
        icon:    r.icon || '/apple-touch-icon.png',
        badge:   '/apple-touch-icon.png',
        tag:     r.reminderId,
        data:    { url: r.url || '/' },
        vibrate: [200, 100, 200],
        requireInteraction: false,
      });
      // Mark as shown (keep for 48h to prevent duplicates)
      await dbPut(db, SHOWN, { reminderId: r.reminderId, shownAt: now });
      await dbDelete(db, STORE, r.reminderId);
    } catch (err) {
      console.error('[SW] Notification error:', err);
    }
  }

  // Clean up old "shown" entries older than 48 hours
  const shown = await dbGetAll(db, SHOWN);
  for (const s of shown) {
    if (now - s.shownAt > 48 * 60 * 60 * 1000) {
      await dbDelete(db, SHOWN, s.reminderId);
    }
  }

  // Schedule setTimeout for next reminder due within 90 minutes
  // (keeps SW alive and fires precisely while device is awake)
  const upcoming = (await dbGetAll(db, STORE))
    .filter(r => r.fireAt > now && r.fireAt < now + 90 * 60 * 1000)
    .sort((a, b) => a.fireAt - b.fireAt);

  if (upcoming.length > 0) {
    const next = upcoming[0];
    const delay = Math.max(0, next.fireAt - Date.now());
    setTimeout(async () => {
      const db2 = await openDB();
      await checkAndFire(db2);
    }, delay + 2000); // +2s buffer
  }
}

// ── Notification click → open/focus the app ──────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin)) {
          return c.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
