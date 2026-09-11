'use strict';
// Shared utilities loaded by both news-quiz.html and admin.html.
// Must load before either page's own inline script (plain <script src>
// tags execute synchronously in document order, so placing this first
// guarantees these are defined as globals before page code runs).

const POINTS = { easy: 10, medium: 20, hard: 30, bonus: 50 };

    function todayStr() {
      // Always use Eastern time — quiz is Baltimore-based
      const eastern = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      return eastern; // returns YYYY-MM-DD
    }

    // Player identity key: trim, collapse internal whitespace runs to one
    // space, lowercase. Mirrors normPlayerKey() in server.js — keep in sync.

    function normPlayerKey(name) {
      return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
    }

    // ═══════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════
    let state = {
      playerName: '',
      currentQ: 0,
      sessionScore: 0,
      streak: 0,
      answers: [],
      phase: 'regular', // regular | bonus | done
      isReplay: false,   // ← add this
      todayKey: todayStr()
    };


    function lsGet(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
    }

    function lsSet(key, val) {
      try {
        localStorage.setItem(key, JSON.stringify(val));
      } catch (e) {
        console.error('[localStorage write failed]', key, e);
      }
    }

    // ─── Players ───

    function getPlayers() { return lsGet('dnq_players') || {}; }
    function savePlayers(p) { lsSet('dnq_players', p); }

    function getTodayQuiz() { return lsGet('dnq_quiz_' + todayStr()); }
    function saveTodayQuiz(q) { lsSet('dnq_quiz_' + todayStr(), q); }

    function escHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }


    function enforceQuizRules(questions) {
      // 1. Deduplicate — reject questions that are clearly about the same topic
      // Use first 60 chars of question text as the key, not sourceUrl (which can be a generic feed URL)
      const seenTopics = new Set();
      const seenUrls = new Set();
      const deduped = questions.filter(q => {
        const topicKey = q.question.slice(0, 60).toLowerCase().replace(/[^a-z0-9]/g, '');
        // Only reject on URL if it's a real article URL (not a generic feed URL)
        const isFeedUrl = !q.sourceUrl || q.sourceUrl.endsWith('/feed/') || q.sourceUrl.endsWith('/feed');
        if (!isFeedUrl && seenUrls.has(q.sourceUrl)) return false;
        if (seenTopics.has(topicKey)) return false;
        seenTopics.add(topicKey);
        if (!isFeedUrl) seenUrls.add(q.sourceUrl);
        return true;
      });

      // 2. Validate correctIndex, shuffle options, and strip feed URLs
      const feedPatterns = ['/feed/', '/rss', 'outboundfeeds/rss'];
      return deduped.map(q => {
        let fixed = { ...q };

        // Range check
        if (fixed.correctIndex < 0 || fixed.correctIndex > 3) fixed.correctIndex = 0;

        // Strip feed URLs
        if (fixed.sourceUrl && feedPatterns.some(p => fixed.sourceUrl.includes(p))) {
          fixed.sourceUrl = '';
        }
        return fixed;
      });
    }

    function formatArchiveDate(dateStr) {
      const d = new Date(dateStr + 'T12:00:00');
      return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }

