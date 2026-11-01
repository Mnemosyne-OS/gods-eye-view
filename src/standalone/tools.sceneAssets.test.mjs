import assert from 'node:assert/strict';
import test from 'node:test';
import { sceneAssetsBaseUrl } from './tools.js';

test('sceneAssetsBaseUrl keeps the cartridge id under mnemo-plugin://', () => {
  assert.equal(
    sceneAssetsBaseUrl(
      'mnemo-plugin://app/@mnemosyne-plugins/mnemo-gods-eye-view/index.html',
    ),
    'mnemo-plugin://app/@mnemosyne-plugins/mnemo-gods-eye-view/scene-assets/',
  );
  // A leading slash (the old construction) would collapse to …/app/scene-assets/
  assert.notEqual(
    new URL(
      '/scene-assets/',
      'mnemo-plugin://app/@mnemosyne-plugins/mnemo-gods-eye-view/index.html',
    ).href,
    sceneAssetsBaseUrl(
      'mnemo-plugin://app/@mnemosyne-plugins/mnemo-gods-eye-view/index.html',
    ),
  );
});

test('sceneAssetsBaseUrl stays absolute under http(s) pages and panel bases', () => {
  assert.equal(
    sceneAssetsBaseUrl('http://127.0.0.1:5239/index.html'),
    'http://127.0.0.1:5239/scene-assets/',
  );
  assert.equal(
    sceneAssetsBaseUrl('https://app.gods-eye-view.invalid/'),
    'https://app.gods-eye-view.invalid/scene-assets/',
  );
});
