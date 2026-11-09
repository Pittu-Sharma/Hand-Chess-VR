/**
 * Hand Chess VR - Main Application Entry Point
 * Immersive Web SDK WebXR seated chess game for Meta Quest.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { ChessSystem } from './chess-system.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(ChessSystem);
});
