'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions } = require('../backend/lib/util');

test('compareVersions: numeric order, missing parts are 0, suffixes ignored, malformed never "older"', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.ok(compareVersions('0.0.9', '0.1.0') < 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('0.1.0-beta.1', '0.1.0'), 0);
  // A Worker reporting a non-numeric version must not be flagged as outdated (updateAvailable).
  assert.equal(compareVersions('dev', '0.1.0'), 0);
  assert.equal(compareVersions('v1.0.0', '0.1.0'), 0);
  assert.equal(compareVersions('', '0.1.0'), 0);
  assert.equal(compareVersions(undefined, '0.1.0'), 0);
});
