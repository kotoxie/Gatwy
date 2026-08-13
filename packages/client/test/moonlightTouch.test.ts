import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ML_TOUCH_MODE_DEFAULT,
  defaultMlTouchMode,
  normalizeMlTouchMode,
  touchModeHelp,
} from '../src/lib/moonlightTouch.ts';

describe('normalizeMlTouchMode', () => {
  it('defaults unset and invalid values', () => {
    assert.equal(normalizeMlTouchMode('pointAndDrag'), 'pointAndDrag');
    assert.equal(normalizeMlTouchMode('localCursor'), 'localCursor');
    assert.equal(normalizeMlTouchMode('mouseRelative'), 'mouseRelative');
    assert.equal(normalizeMlTouchMode('touch'), 'touch');
    assert.equal(normalizeMlTouchMode('nope'), defaultMlTouchMode());
    assert.equal(normalizeMlTouchMode(''), defaultMlTouchMode());
  });

  it('uses pointAndDrag as the Gatwy default', () => {
    assert.equal(ML_TOUCH_MODE_DEFAULT, 'pointAndDrag');
    assert.equal(defaultMlTouchMode(), 'pointAndDrag');
  });

  it('returns help text for each mode', () => {
    assert.match(touchModeHelp('pointAndDrag'), /tap to click/i);
    assert.match(touchModeHelp('localCursor'), /on-screen pointer/i);
    assert.match(touchModeHelp('mouseRelative'), /trackpad/i);
    assert.match(touchModeHelp('touch'), /multitouch/i);
  });
});
