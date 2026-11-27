/* Student ID Scanner — Web (kiosk) version.
 * Shares the SAME Firestore data as the Android cloud app:
 *   users/{uid}/students/{studentId}
 *   users/{uid}/attendance/{studentId_yyyy-MM-dd}
 *   users/{uid}/history/{autoId}
 *   users/{uid}/settings/profile
 *   users/{uid}/holidays/{yyyy-MM-dd}  {date, title} — written by the
 *     scanner app; read-only here (live list, no add/edit/delete).
 * Read-only + scanning only: no student add/edit/delete, no PIN, no seeding.
 */
(function () {
  "use strict";

  firebase.initializeApp(firebaseConfig);
  var auth = firebase.auth();
  var db = firebase.firestore();
  db.enablePersistence().catch(function () { /* offline cache unavailable; online still works */ });

  var TZ = "Asia/Dhaka";
  var CLASS_ORDER = ["শিশু", "প্রথম", "দ্বিতীয়", "তৃতীয়", "চতুর্থ", "পঞ্চম",
    "ষষ্ঠ", "সপ্তম", "অষ্টম", "নবম", "দশম", "একাদশ", "দ্বাদশ"];
  var DAY_NAMES = ["রবিবার", "সোমবার", "মঙ্গলবার", "বুধবার", "বৃহস্পতিবার", "শুক্রবার", "শনিবার"];
  var FOOTNOTE = "প্রতিদিন রাত ৮টার মধ্যে QR স্ক্যান করলে উপস্থিত হবে; স্ক্যান না হলে অনুপস্থিত দেখাবে।";

  var uid = null;
  var students = [];
  var studentsById = {};
  var historyDocs = [];
  var holidays = [];
  var unsubscribers = [];
  var weekOffset = 0;
  var selectedStudentId = null;

  function $(id) { return document.getElementById(id); }

  /* ---------- Dhaka date/time helpers ---------- */
  function dhakaParts(millis) {
    var fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    });
    var parts = {};
    fmt.formatToParts(new Date(millis)).forEach(function (p) { parts[p.type] = p.value; });
    return parts;
  }
  function dateString(millis) {
    var p = dhakaParts(millis);
    return p.year + "-" + p.month + "-" + p.day;
  }
  function dhakaHour(millis) { return parseInt(dhakaParts(millis).hour, 10) % 24; }
  function formatTime(millis) {
    var p = dhakaParts(millis);
    var h = parseInt(p.hour, 10) % 24;
    var ap = h < 12 ? "AM" : "PM";
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ":" + p.minute + ":" + p.second + " " + ap;
  }
  function formatDateBn(millis) {
    return new Intl.DateTimeFormat("bn-BD", {
      timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric"
    }).format(new Date(millis));
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- Clock ---------- */
  function tickClock() {
    var now = Date.now();
    $("clockTime").textContent = formatTime(now);
    $("clockDate").textContent = formatDateBn(now);
  }
  setInterval(tickClock, 1000);
  tickClock();

  /* ---------- Tabs ---------- */
  document.querySelectorAll("nav.tabs button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("nav.tabs button").forEach(function (b) { b.classList.remove("active"); });
      document.querySelectorAll("section.tab").forEach(function (s) { s.classList.remove("active"); });
      btn.classList.add("active");
      $("tab-" + btn.getAttribute("data-tab")).classList.add("active");
    });
  });

  /* ---------- Auth ---------- */
  $("signInBtn").addEventListener("click", function () {
    $("loginError").classList.add("hidden");
    var provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(function (err) {
      var el = $("loginError");
      el.textContent = "লগইন হয়নি। পপআপ বন্ধ করে থাকলে অনুমতি দিন, তারপর আবার চেষ্টা করুন। (" + err.code + ")";
      el.classList.remove("hidden");
    });
  });
  $("signOutBtn").addEventListener("click", function () {
    stopCamera();
    auth.signOut();
  });

  auth.onAuthStateChanged(function (user) {
    if (user) {
      uid = user.uid;
      $("loginScreen").classList.add("hidden");
      $("appScreen").classList.remove("hidden");
      $("userEmail").textContent = user.email || "";
      $("userEmail").classList.remove("hidden");
      $("signOutBtn").classList.remove("hidden");
      startListeners();
    } else {
      uid = null;
      stopCamera();
      unsubscribers.forEach(function (u) { u(); });
      unsubscribers = [];
      students = []; studentsById = {}; historyDocs = []; holidays = [];
      renderHolidays();
      $("loginScreen").classList.remove("hidden");
      $("appScreen").classList.add("hidden");
      $("userEmail").classList.add("hidden");
      $("signOutBtn").classList.add("hidden");
      $("institutionName").textContent = "Student ID Scanner";
    }
  });

  /* ---------- Firestore listeners ---------- */
  function userDoc() { return db.collection("users").doc(uid); }
  function studentsRef() { return userDoc().collection("students"); }
  function attendanceRef() { return userDoc().collection("attendance"); }
  function historyRef() { return userDoc().collection("history"); }
  function holidaysRef() { return userDoc().collection("holidays"); }

  function startListeners() {
    unsubscribers.push(userDoc().collection("settings").doc("profile").onSnapshot(function (snap) {
      var data = snap.exists ? snap.data() : null;
      var name = (data && data.institutionName) ? data.institutionName : "Student ID Scanner";
      $("institutionName").textContent = name;
    }));
    unsubscribers.push(studentsRef().orderBy("name").onSnapshot(function (snap) {
      students = snap.docs.map(function (d) {
        var s = d.data() || {};
        if (!s.studentId) s.studentId = d.id;
        return s;
      });
      studentsById = {};
      students.forEach(function (s) { studentsById[s.studentId] = s; });
      renderStudents();
      renderHistory();
    }));
    unsubscribers.push(historyRef().orderBy("scannedAt", "desc").limit(100).onSnapshot(function (snap) {
      historyDocs = snap.docs.map(function (d) {
        var h = d.data() || {};
        h.id = d.id;
        return h;
      });
      renderHistory();
    }));
    unsubscribers.push(attendanceRef().where("date", "==", dateString(Date.now())).onSnapshot(function (snap) {
      var seen = {};
      snap.docs.forEach(function (d) {
        var a = d.data() || {};
        if (a.studentId) seen[a.studentId] = true;
      });
      $("todayCount").textContent = Object.keys(seen).length;
    }));
    // Holidays: read-only live list, same listener pattern as above.
    // Sorted by date ascending; the doc id is the yyyy-MM-dd date, so
    // fall back to it when the date field is missing.
    unsubscribers.push(holidaysRef().orderBy("date").onSnapshot(function (snap) {
      holidays = snap.docs.map(function (d) {
        var h = d.data() || {};
        return { date: h.date || d.id, title: h.title || "" };
      });
      holidays.sort(function (a, b) {
        return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
      });
      renderHolidays();
    }));
  }

  /* ---------- Scanning ---------- */
  var video = $("video");
  var canvas = $("decodeCanvas");
  var stream = null;
  var scanning = false;
  var cooldownUntil = 0;
  var resultTimer = null;
  // Scan modes: "attendance" (default) records attendance + history
  // automatically and auto-resumes; "info" shows the info card only and
  // writes NOTHING. The manual ID box respects the current mode too.
  var scanMode = "attendance";

  function setScanMode(mode) {
    scanMode = mode;
    clearTimeout(resultTimer);
    $("scanResult").innerHTML = "";
    cooldownUntil = 0;
    var att = $("modeAttendanceBtn"), info = $("modeInfoBtn");
    att.className = mode === "attendance" ? "btn-green" : "btn-outline";
    info.className = mode === "info" ? "btn-green" : "btn-outline";
    $("modeNote").textContent = mode === "attendance"
      ? "হাজিরা মোড: স্ক্যান করলেই হাজিরা লেখা হবে, কাউকে থাকতে হবে না।"
      : "তথ্য মোড: শুধু তথ্য দেখাবে, হাজিরা লেখা হবে না।";
  }
  $("modeAttendanceBtn").addEventListener("click", function () { setScanMode("attendance"); });
  $("modeInfoBtn").addEventListener("click", function () { setScanMode("info"); });

  function showCameraError(msg) {
    var el = $("cameraError");
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  function startCamera() {
    $("cameraError").classList.add("hidden");
    var constraints = { audio: false, video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } } };
    navigator.mediaDevices.getUserMedia(constraints).catch(function () {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }).then(function (s) {
      stream = s;
      video.srcObject = s;
      return video.play();
    }).then(function () {
      scanning = true;
      $("scannerOff").classList.add("hidden");
      $("scanFrame").classList.remove("hidden");
      $("cameraBtn").classList.add("hidden");
      $("stopCameraBtn").classList.remove("hidden");
      requestAnimationFrame(decodeLoop);
    }).catch(function (err) {
      var msg = "ক্যামেরা চালু করা যায়নি। ব্রাউজারে ক্যামেরার অনুমতি দিন এবং পাতাটি HTTPS দিয়ে খুলুন।";
      if (err && err.name === "NotAllowedError") msg = "ক্যামেরার অনুমতি দেওয়া হয়নি। ব্রাউজারের ঠিকানা বারের পাশে ক্যামেরা আইকনে চাপ দিয়ে অনুমতি দিন, তারপর আবার চেষ্টা করুন।";
      if (err && (err.name === "NotFoundError" || err.name === "OverconstrainedError")) msg = "এই ডিভাইসে কোনো ক্যামেরা পাওয়া যায়নি। ওয়েবক্যাম লাগানো আছে কিনা দেখুন।";
      showCameraError(msg);
    });
  }

  function stopCamera() {
    scanning = false;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    video.srcObject = null;
    $("scannerOff").classList.remove("hidden");
    $("scanFrame").classList.add("hidden");
    $("cameraBtn").classList.remove("hidden");
    $("stopCameraBtn").classList.add("hidden");
  }

  $("cameraBtn").addEventListener("click", startCamera);
  $("stopCameraBtn").addEventListener("click", stopCamera);

  function decodeLoop() {
    if (!scanning) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && Date.now() >= cooldownUntil) {
      var w = video.videoWidth, h = video.videoHeight;
      if (w && h) {
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, w, h);
        try {
          var imageData = ctx.getImageData(0, 0, w, h);
          var code = jsQR(imageData.data, w, h, { inversionAttempts: "attemptBoth" });
          if (code && code.data) {
            handleScanned(code.data);
            return; // handleScanned re-arms the loop after the result clears
          }
        } catch (e) { /* ignore a bad frame */ }
      }
    }
    requestAnimationFrame(decodeLoop);
  }

  function handleScanned(raw) {
    var now = Date.now();
    cooldownUntil = now + 4000;
    var idUpper = raw.trim().toUpperCase();
    var student = studentsById[idUpper] || studentsById[raw.trim()] || null;
    if (student) {
      if (scanMode === "info") {
        // Info mode: show the full info card, write NOTHING.
        showFoundInfo(student, now);
        return;
      }
      var docId = student.studentId + "_" + dateString(now);
      var batch = db.batch();
      batch.set(attendanceRef().doc(docId), {
        studentId: student.studentId, date: dateString(now), scannedAt: now
      });
      batch.set(historyRef().doc(), { studentId: student.studentId, scannedAt: now });
      batch.commit().then(function () { showThanks(student, now); })
        .catch(function () { showThanks(student, now); /* card shows; writes retry on next scan */ });
    } else {
      showNotFound(raw.trim());
    }
  }

  // Attendance mode: thank-you only (name + frozen scan time), no info
  // card. Auto-clears after 4 seconds and resumes scanning by itself.
  function showThanks(student, now) {
    clearTimeout(resultTimer);
    var hour = dhakaHour(now);
    var sessionLabel = hour < 12 ? "সকাল" : "বিকেল";
    $("scanResult").innerHTML =
      '<div class="result found"><h2>ধন্যবাদ আপনার হাজিরা সম্পূর্ণ</h2>' +
      "<p><b>" + escapeHtml(student.name) + "</b></p>" +
      '<p class="scan-time">স্ক্যানের সময়: ' + formatTime(now) + " (" + sessionLabel + ")</p>" +
      "<p>পরের কার্ডের জন্য তৈরি হচ্ছে…</p></div>";
    resultTimer = setTimeout(function () {
      $("scanResult").innerHTML = "";
      cooldownUntil = 0;
      if (scanning) requestAnimationFrame(decodeLoop);
    }, 4000);
  }

  // Info mode: full info card, no Firestore writes. Stays on screen until
  // the user taps "আবার স্ক্যান করুন" — no auto-clear in this mode.
  function showFoundInfo(student, now) {
    clearTimeout(resultTimer);
    var hour = dhakaHour(now);
    var sessionLabel = hour < 12 ? "সকাল" : "বিকেল";
    var photoHtml;
    if (student.photoUrl && /^https?:\/\//i.test(student.photoUrl)) {
      photoHtml = '<img class="avatar" src="' + escapeHtml(student.photoUrl) + '" alt="">';
    } else {
      var initial = (student.name || "?").trim().charAt(0);
      photoHtml = '<div class="avatar">' + escapeHtml(initial) + "</div>";
    }
    $("scanResult").innerHTML =
      '<div class="result found"><h2>✓ Student Found</h2>' +
      '<div class="who">' + photoHtml +
      '<div class="meta"><b>' + escapeHtml(student.name) + "</b><br>" +
      "আইডি: " + escapeHtml(student.studentId) + "<br>" +
      "শ্রেণি: " + escapeHtml(student.className) +
      (student.section ? " (" + escapeHtml(student.section) + ")" : "") +
      " • রোল: " + escapeHtml(student.roll) + "<br>" +
      "সেশন: " + escapeHtml(student.session) +
      (student.phone ? " • মোবাইল: " + escapeHtml(student.phone) : "") +
      "</div></div>" +
      '<p class="scan-time">স্ক্যানের সময়: ' + formatTime(now) + " (" + sessionLabel + ")</p>" +
      '<p><button id="rescanBtn" class="btn-green" type="button">আবার স্ক্যান করুন</button></p></div>';
    $("rescanBtn").addEventListener("click", function () {
      $("scanResult").innerHTML = "";
      cooldownUntil = 0;
      if (scanning) requestAnimationFrame(decodeLoop);
    });
  }

  function showNotFound(raw) {
    clearTimeout(resultTimer);
    $("scanResult").innerHTML =
      '<div class="result notfound"><h2>✕ Student Not Found</h2>' +
      "<p>“" + escapeHtml(raw) + "” আইডির কোনো ছাত্র পাওয়া যায়নি। আবার স্ক্যান করুন।</p></div>";
    resultTimer = setTimeout(function () {
      $("scanResult").innerHTML = "";
      cooldownUntil = 0;
      if (scanning) requestAnimationFrame(decodeLoop);
    }, 4000);
  }

  $("manualBtn").addEventListener("click", function () {
    var val = $("manualId").value;
    if (!val.trim()) return;
    handleScanned(val);
    $("manualId").value = "";
  });
  $("manualId").addEventListener("keydown", function (e) {
    if (e.key === "Enter") $("manualBtn").click();
  });

  /* ---------- Students tab ---------- */
  function classRank(className) {
    var idx = CLASS_ORDER.indexOf((className || "").trim());
    return idx === -1 ? CLASS_ORDER.length : idx;
  }
  function classGroupName(className) {
    return (className || "").trim() || "শ্রেণি উল্লেখ নেই";
  }
  function rollKey(roll) {
    var n = parseInt(String(roll || "").replace(/[^0-9]/g, ""), 10);
    return isNaN(n) ? 999999 : n;
  }

  function getFilteredStudents() {
    var q = $("searchInput").value.trim().toLowerCase();
    var list = students;
    if (q) {
      list = students.filter(function (s) {
        return (s.studentId || "").toLowerCase().indexOf(q) !== -1 ||
          (s.name || "").toLowerCase().indexOf(q) !== -1 ||
          (s.className || "").toLowerCase().indexOf(q) !== -1 ||
          (s.roll || "").toLowerCase().indexOf(q) !== -1;
      });
    }
    return list.slice().sort(function (a, b) {
      var ra = classRank(a.className), rb = classRank(b.className);
      if (ra !== rb) return ra - rb;
      var ga = classGroupName(a.className), gb = classGroupName(b.className);
      if (ga !== gb) return ga.localeCompare(gb, "bn");
      var ro = rollKey(a.roll) - rollKey(b.roll);
      if (ro !== 0) return ro;
      return (a.name || "").localeCompare(b.name || "", "bn");
    });
  }

  function renderStudents() {
    var list = getFilteredStudents();
    var box = $("studentsList");
    if (!list.length) {
      box.innerHTML = '<p class="empty">কোনো ছাত্র পাওয়া যায়নি।</p>';
      return;
    }
    var html = "", currentGroup = null;
    list.forEach(function (s) {
      var g = classGroupName(s.className);
      if (g !== currentGroup) {
        if (currentGroup !== null) html += "</div>";
        html += '<div class="class-group"><h3>' + escapeHtml(g) + "</h3>";
        currentGroup = g;
      }
      html += '<button type="button" class="student-row" data-id="' + escapeHtml(s.studentId) + '">' +
        "<span><b>" + escapeHtml(s.name) + '</b><br><span class="roll">আইডি: ' + escapeHtml(s.studentId) + "</span></span>" +
        '<span class="roll">রোল: ' + escapeHtml(s.roll) + "</span></button>";
    });
    html += "</div>";
    box.innerHTML = html;
    box.querySelectorAll(".student-row").forEach(function (row) {
      row.addEventListener("click", function () { selectStudent(row.getAttribute("data-id")); });
    });
  }

  $("searchInput").addEventListener("input", renderStudents);

  function weekDates(offset) {
    var now = new Date(Date.now());
    // Dhaka day-of-week: use UTC math on the Dhaka date string to avoid TZ drift.
    var p = dhakaParts(Date.now());
    var base = new Date(Date.UTC(parseInt(p.year, 10), parseInt(p.month, 10) - 1, parseInt(p.day, 10)));
    var dow = base.getUTCDay(); // 0=Sun..6=Sat
    var backToSat = (dow + 1) % 7; // days since Saturday
    var sat = new Date(base.getTime() - backToSat * 86400000 + offset * 7 * 86400000);
    var days = [];
    for (var i = 0; i < 7; i++) days.push(new Date(sat.getTime() + i * 86400000));
    return days;
  }
  function utcDateString(d) {
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  }

  function selectStudent(studentId) {
    selectedStudentId = studentId;
    weekOffset = 0;
    renderProfile();
  }

  function renderProfile() {
    var s = studentsById[selectedStudentId];
    var box = $("studentProfile");
    if (!s) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    box.innerHTML =
      "<h3>" + escapeHtml(s.name) + "</h3>" +
      '<p class="sub">আইডি: ' + escapeHtml(s.studentId) +
      " • শ্রেণি: " + escapeHtml(s.className) +
      (s.section ? " (" + escapeHtml(s.section) + ")" : "") +
      " • রোল: " + escapeHtml(s.roll) + " • সেশন: " + escapeHtml(s.session) + "</p>" +
      "<p>পিতা: " + escapeHtml(s.fatherName) + "<br>মাতা: " + escapeHtml(s.motherName) +
      (s.phone ? "<br>মোবাইল: " + escapeHtml(s.phone) : "") + "</p>" +
      '<div class="week-nav"><button type="button" class="btn-outline" id="prevWeek">← আগের সপ্তাহ</button>' +
      '<button type="button" class="btn-outline" id="nextWeek">পরের সপ্তাহ →</button></div>' +
      '<button type="button" class="btn-outline" id="weekCsvBtn" style="margin:8px 0;">সাপ্তাহিক হাজিরা CSV ডাউনলোড (সব ছাত্র)</button>' +
      '<div id="weekRows"><p class="empty">হাজিরা লোড হচ্ছে…</p></div>' +
      '<p class="footnote">' + FOOTNOTE + "</p>";
    $("prevWeek").addEventListener("click", function () { weekOffset--; renderProfile(); });
    $("nextWeek").addEventListener("click", function () { weekOffset++; renderProfile(); });
    $("weekCsvBtn").addEventListener("click", exportWeekCsv);
    loadWeekAttendance(s.studentId);
  }

  function loadWeekAttendance(studentId) {
    attendanceRef().where("studentId", "==", studentId).get().then(function (snap) {
      if (studentId !== selectedStudentId) return;
      var byDate = {};
      snap.docs.forEach(function (d) {
        var a = d.data() || {};
        if (a.date) byDate[a.date] = a;
      });
      var days = weekDates(weekOffset);
      var todayStr = dateString(Date.now());
      var nowHour = dhakaHour(Date.now());
      var html = "";
      days.forEach(function (day, i) {
        var ds = utcDateString(day);
        var rec = byDate[ds];
        var label = DAY_NAMES[(6 + i) % 7]; // Saturday first
        var dateLabel = new Intl.DateTimeFormat("bn-BD", { timeZone: "UTC", day: "numeric", month: "long" }).format(day);
        var badge, extra = "";
        if (rec) {
          badge = '<span class="badge present">উপস্থিত</span>';
          extra = " • " + formatTime(rec.scannedAt) + " (" + (dhakaHour(rec.scannedAt) < 12 ? "সকাল" : "বিকেল") + ")";
        } else if (ds < todayStr || (ds === todayStr && nowHour >= 20)) {
          badge = '<span class="badge absent">অনুপস্থিত</span>';
        } else {
          badge = '<span class="badge pending">এখনো বাকি</span>';
        }
        html += '<div class="week-row"><span>' + label + " • " + dateLabel + extra + "</span>" + badge + "</div>";
      });
      var rows = $("weekRows");
      if (rows) rows.innerHTML = html;
    }).catch(function () {
      var rows = $("weekRows");
      if (rows) rows.innerHTML = '<p class="empty">হাজিরা লোড করা যায়নি। ইন্টারনেট দেখে আবার চেষ্টা করুন।</p>';
    });
  }

  /* ---------- Attendance CSV export ---------- */
  var CSV_HEADER = "Date,Student ID,Name,Class,Roll,Status,Scan Time,Session";

  function csvEscape(v) {
    return '"' + String(v == null ? "" : v).replace(/"/g, "") + '"';
  }

  /* Same status rules as the weekly view and the Android app: a record
   * means present (with Dhaka scan time + morning/afternoon); a past
   * date, or today at/after 20:00, with no record means absent; anything
   * else is still pending. Returns [status, scanTime, session]. */
  function attendanceStatus(rec, ds, todayStr, nowHour) {
    if (rec) {
      return ["উপস্থিত", formatTime(rec.scannedAt), dhakaHour(rec.scannedAt) < 12 ? "সকাল" : "বিকেল"];
    }
    if (ds < todayStr || (ds === todayStr && nowHour >= 20)) return ["অনুপস্থিত", "", ""];
    return ["এখনো বাকি", "", ""];
  }

  function attendanceCsvRows(byKey, dates) {
    var todayStr = dateString(Date.now());
    var nowHour = dhakaHour(Date.now());
    var lines = [CSV_HEADER];
    students.forEach(function (s) {
      dates.forEach(function (ds) {
        var st = attendanceStatus(byKey[s.studentId + "_" + ds], ds, todayStr, nowHour);
        lines.push([ds, s.studentId, s.name, s.className, s.roll, st[0], st[1], st[2]].map(csvEscape).join(","));
      });
    });
    return lines.join("\n") + "\n";
  }

  function downloadCsv(filename, text) {
    var blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* Today's attendance, one row per student. */
  function exportTodayCsv() {
    var todayStr = dateString(Date.now());
    attendanceRef().where("date", "==", todayStr).get().then(function (snap) {
      var byKey = {};
      snap.docs.forEach(function (d) {
        var a = d.data() || {};
        if (a.studentId && a.date) byKey[a.studentId + "_" + a.date] = a;
      });
      downloadCsv("attendance-" + todayStr + ".csv", attendanceCsvRows(byKey, [todayStr]));
    });
  }

  /* Current (viewed) Sat-Fri week, one row per student per day. */
  function exportWeekCsv() {
    attendanceRef().get().then(function (snap) {
      var byKey = {};
      snap.docs.forEach(function (d) {
        var a = d.data() || {};
        if (a.studentId && a.date) byKey[a.studentId + "_" + a.date] = a;
      });
      var days = weekDates(weekOffset).map(utcDateString);
      downloadCsv("attendance-week-" + days[0] + ".csv", attendanceCsvRows(byKey, days));
    });
  }

  $("exportTodayBtn").addEventListener("click", exportTodayCsv);

  /* ---------- History tab ---------- */
  function renderHistory() {
    var box = $("historyList");
    var todayStr = dateString(Date.now());
    var todays = historyDocs.filter(function (h) { return dateString(h.scannedAt) === todayStr; });
    if (!todays.length) {
      box.innerHTML = '<p class="empty">আজ এখনো কোনো স্ক্যান হয়নি।</p>';
      return;
    }
    box.innerHTML = todays.map(function (h) {
      var s = studentsById[h.studentId];
      var name = s ? s.name : h.studentId;
      var detail = s ? ("আইডি: " + s.studentId + " • শ্রেণি: " + s.className + " • রোল: " + s.roll) : "";
      return '<div class="history-row"><span><b>' + escapeHtml(name) + "</b><br>" +
        '<span style="color:var(--muted);font-size:14px;">' + escapeHtml(detail) + "</span></span>" +
        '<span class="time">' + formatTime(h.scannedAt) + "</span></div>";
    }).join("");
  }
  /* ---------- Holidays tab (read-only) ---------- */
  function formatHolidayDate(dateStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || "").trim());
    if (!m) return String(dateStr || "");
    var day = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
    return new Intl.DateTimeFormat("bn-BD", {
      timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric"
    }).format(day);
  }

  function renderHolidays() {
    var box = $("holidaysList");
    if (!box) return;
    if (!holidays.length) {
      box.innerHTML = '<p class="empty">কোনো ছুটির দিন নেই।</p>';
      return;
    }
    box.innerHTML = holidays.map(function (h) {
      return '<div class="holiday-row"><span><b>' + escapeHtml(h.title || "ছুটি") + "</b><br>" +
        '<span style="color:var(--muted);font-size:14px;">' + escapeHtml(formatHolidayDate(h.date)) + "</span></span>" +
        '<span class="time">' + escapeHtml(h.date) + "</span></div>";
    }).join("");
  }
})();
