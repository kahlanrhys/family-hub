// ═══════════════════════════════════════════════════════════
// Family App — Service Worker
// Handles scheduled event reminders — fires via ntfy.sh
// ═══════════════════════════════════════════════════════════
const DB_NAME = 'familyAppSW';
const DB_VER  = 1;
const STORE   = 'reminders';
const SHOWN   = 'shown';

// ── IndexedDB helpers ─────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: 'reminderId' });
      if (!db.objectStoreNames.contains(SHOWN))
        db.createObjectStore(SHOWN, { keyPath: 'reminderId' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}
function dbGet(db, store, key) {
  return new Promise((res, rej) => {
    const req = db.transaction(store,'readonly').objectStore(store).get(key);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
function dbPut(db, store, val) {
  return new Promise((res, rej) => {
    const req = db.transaction(store,'readwrite').objectStore(store).put(val);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
function dbGetAll(db, store) {
  return new Promise((res, rej) => {
    const req = db.transaction(store,'readonly').objectStore(store).getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
function dbDelete(db, store, key) {
  return new Promise((res, rej) => {
    const req = db.transaction(store,'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}
function dbClear(db, store) {
  return new Promise((res, rej) => {
    const req = db.transaction(store,'readwrite').objectStore(store).clear();
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

// ── Install & activate ────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(clients.claim()));

// ── Receive reminders from main thread ────────────────────
self.addEventListener('message', async e => {
  if (e.data?.type === 'SCHEDULE_REMINDERS') {
    const db = await openDB();
    await dbClear(db, STORE);
    for (const r of (e.data.reminders || [])) {
      await dbPut(db, STORE, r);
    }
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

// ── Core: check reminders and fire due ones ───────────────
async function checkAndFire(db) {
  const now       = Date.now();
  const reminders = await dbGetAll(db, STORE);

  for (const r of reminders) {
    if (r.fireAt > now) continue;
    if (r.fireAt < now - 30 * 60 * 1000) {
      // More than 30 min late — skip silently
      await dbDelete(db, STORE, r.reminderId);
      continue;
    }

    // Check already shown
    const alreadyShown = await dbGet(db, SHOWN, r.reminderId);
    if (alreadyShown) {
      await dbDelete(db, STORE, r.reminderId);
      continue;
    }

    // ── Send via ntfy (primary — works when app is closed) ──
    if (r.ntfyTopic && r.ntfyServer) {
      try {
        await fetch(r.ntfyServer + '/' + r.ntfyTopic, {
          method: 'POST',
          body:   'Reminder: ' + r.body,
          headers: {
            'Title':    r.title,       // plain ASCII — no emoji in header
            'Priority': 'high',
            'Tags':     'alarm_clock',
          },
        });
      } catch(e) {
        console.warn('[SW] ntfy send failed:', e.message);
      }
    }

    // ── Browser notification (secondary — only works if app open/PWA) ──
    try {
      await self.registration.showNotification('📅 ' + r.title, {
        body:    r.body,
        tag:     r.reminderId,
        data:    { url: r.url || '/' },
        vibrate: [200, 100, 200],
      });
    } catch(e) {
      // Browser notifications not available — ntfy handled it above
    }

    // Mark as shown
    await dbPut(db, SHOWN, { reminderId: r.reminderId, shownAt: now });
    await dbDelete(db, STORE, r.reminderId);
  }

  // Clean up old shown entries (older than 48h)
  const shown = await dbGetAll(db, SHOWN);
  for (const s of shown) {
    if (now - s.shownAt > 48 * 60 * 60 * 1000)
      await dbDelete(db, SHOWN, s.reminderId);
  }

  // Schedule setTimeout for reminders due within 90 minutes
  const upcoming = (await dbGetAll(db, STORE))
    .filter(r => r.fireAt > now && r.fireAt < now + 90 * 60 * 1000)
    .sort((a, b) => a.fireAt - b.fireAt);

  if (upcoming.length > 0) {
    const delay = Math.max(0, upcoming[0].fireAt - Date.now()) + 2000;
    setTimeout(async () => {
      const db2 = await openDB();
      await checkAndFire(db2);
    }, delay);
  }
}

// ── Notification click → focus/open the app ──────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin)) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
