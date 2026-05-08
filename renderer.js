/**
 * renderer.js — ScoreRenderer
 * Wraps abcjs to render ABC notation as a score in a DOM element,
 * with note highlighting support via CSS classes.
 *
 * Assumes abcjs is already loaded on the page before this script:
 *   https://cdn.jsdelivr.net/npm/abcjs@6.4.3/dist/abcjs-basic-min.js
 */

(function () {
  'use strict';

  // ─── Style injection (once per page load) ───────────────────────────────────

  let _stylesInjected = false;

  function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;

    const style = document.createElement('style');
    style.id = 'score-renderer-styles';
    style.textContent = `
      /* Score container */
      .score-renderer-container {
        background: #ffffff;
        border-radius: 8px;
        padding: 16px;
        overflow-x: auto;
        box-sizing: border-box;
      }

      /* Note highlight — override abcjs fill color */
      .abcjs-note.highlighted {
        fill: #7c6af7 !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ─── ScoreRenderer class ────────────────────────────────────────────────────

  /**
   * ScoreRenderer
   *
   * @example
   *   const renderer = new ScoreRenderer('score-container');
   *   renderer.render('X:1\nT:Title\nK:C\nCDEF|');
   *   renderer.highlightNote(2);  // highlight the 3rd note (0-based)
   *   renderer.clearHighlight();
   *   renderer.clear();
   */
  class ScoreRenderer {
    /**
     * @param {string} containerId - id of the <div> to render the score into
     */
    constructor(containerId) {
      this._containerId = containerId;
      this._visualObj = null;  // last result returned by ABCJS.renderAbc

      // Inject shared styles the first time any instance is created
      injectStyles();

      // Apply container class for styling (if element already exists in DOM)
      const el = document.getElementById(containerId);
      if (el) {
        el.classList.add('score-renderer-container');
      }
    }

    /**
     * Render ABC notation into the container.
     *
     * @param {string} abcText - ABC notation string
     * @returns {object|null} raw abcjs visual object, or null on failure
     */
    render(abcText) {
      const el = document.getElementById(this._containerId);
      if (!el) {
        console.error(`[ScoreRenderer] Container element #${this._containerId} not found.`);
        return null;
      }

      if (typeof ABCJS === 'undefined') {
        console.warn('[ScoreRenderer] abcjs is not loaded yet. Cannot render.');
        return null;
      }

      // Ensure container class is present (element may have been created after constructor)
      el.classList.add('score-renderer-container');

      try {
        this._visualObj = ABCJS.renderAbc(this._containerId, abcText, {
          responsive: 'resize',
          add_classes: true,   // adds CSS classes to SVG note elements
        });
      } catch (err) {
        console.error('[ScoreRenderer] abcjs renderAbc threw:', err);
        return null;
      }

      return this._visualObj;
    }

    /**
     * Clear the rendered score from the container.
     */
    clear() {
      const el = document.getElementById(this._containerId);
      if (!el) {
        console.error(`[ScoreRenderer] Container element #${this._containerId} not found.`);
        return;
      }
      el.innerHTML = '';
      this._visualObj = null;
    }

    /**
     * Highlight a note by its 0-based index in the rendered score.
     * First removes any existing highlight, then applies to the target note.
     *
     * @param {number} index - 0-based note index
     */
    highlightNote(index) {
      // Always clear previous highlight first
      this.clearHighlight();

      const el = document.getElementById(this._containerId);
      if (!el) {
        console.error(`[ScoreRenderer] Container element #${this._containerId} not found.`);
        return;
      }

      // abcjs with add_classes:true marks notes with class "abcjs-note"
      const notes = el.querySelectorAll('.abcjs-note');
      if (notes.length === 0) {
        console.warn('[ScoreRenderer] No .abcjs-note elements found. Has render() been called?');
        return;
      }

      if (index < 0 || index >= notes.length) {
        console.warn(
          `[ScoreRenderer] Note index ${index} out of range (0–${notes.length - 1}).`
        );
        return;
      }

      notes[index].classList.add('highlighted');
    }

    /**
     * Remove highlight from all notes.
     */
    clearHighlight() {
      const el = document.getElementById(this._containerId);
      if (!el) {
        console.error(`[ScoreRenderer] Container element #${this._containerId} not found.`);
        return;
      }

      el.querySelectorAll('.abcjs-note.highlighted').forEach((note) => {
        note.classList.remove('highlighted');
      });
    }
  }

  // ─── Export ─────────────────────────────────────────────────────────────────
  window.ScoreRenderer = ScoreRenderer;

})();
