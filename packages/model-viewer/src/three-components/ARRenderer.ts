/* @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import '../types/webxr.js';

import {Event as ThreeEvent, EventDispatcher, Matrix4, Vector3, WebGLRenderer} from 'three';

import {ControlsInterface} from '../features/controls.js';
import ModelViewerElementBase, {$onResize, $sceneIsReady} from '../model-viewer-base.js';
import {assertIsArCandidate} from '../utilities.js';

import {Damper, DECAY_MILLISECONDS} from './Damper.js';
import {ModelScene} from './ModelScene.js';
import {PlacementBox} from './PlacementBox.js';
import {Renderer} from './Renderer.js';

// AR shadow is not user-configurable. This is to pave the way for AR lighting
// estimation, which will be used once available in WebXR.
const AR_SHADOW_INTENSITY = 0.3;
const ROTATION_RATE = 1.5;
// Angle down (towards bottom of screen) from camera center ray to use for hit
// testing against the floor. This makes placement faster and more intuitive
// assuming the phone is in portrait mode. This seems to be a reasonable
// assumption for the start of the session and UI will lack landscape mode to
// encourage upright use.
const HIT_ANGLE_DEG = 20;
// Slow down the dampers for initial placement.
const INTRO_DECAY = 120;
const SCALE_SNAP_HIGH = 1.2;
const SCALE_SNAP_LOW = 1 / SCALE_SNAP_HIGH;

// For automatic dynamic viewport scaling, don't let the scale drop below this
// limit.
const MIN_VIEWPORT_SCALE = 0.25;

export type ARStatus =
    'not-presenting'|'session-started'|'object-placed'|'failed';

export const ARStatus: {[index: string]: ARStatus} = {
  NOT_PRESENTING: 'not-presenting',
  SESSION_STARTED: 'session-started',
  OBJECT_PLACED: 'object-placed',
  FAILED: 'failed'
};

export interface ARStatusEvent extends ThreeEvent {
  status: ARStatus,
}

const vector3 = new Vector3();
const matrix4 = new Matrix4();
const hitPosition = new Vector3();

export class ARRenderer extends EventDispatcher {
  public threeRenderer: WebGLRenderer;
  public currentSession: XRSession|null = null;
  public placeOnWall = false;
  public cameraPosition = new Vector3();

  private placementBox: PlacementBox|null = null;
  private lastTick: number|null = null;
  private turntableRotation: number|null = null;
  private oldShadowIntensity: number|null = null;
  private oldBackground: any = null;
  private rafId: number|null = null;
  private frame: XRFrame|null = null;
  private initialHitSource: XRHitTestSource|null = null;
  private transientHitTestSource: XRTransientInputHitTestSource|null = null;
  private inputSource: XRInputSource|null = null;
  private _presentedScene: ModelScene|null = null;
  private resolveCleanup: ((...args: any[]) => void)|null = null;
  private exitWebXRButtonContainer: HTMLElement|null = null;

  private initialized = false;
  private oldTarget = new Vector3();
  private placementComplete = false;
  private isTranslating = false;
  private isRotating = false;
  private isScaling = false;
  private lastDragPosition = new Vector3();
  private lastScalar = 0;
  private goalPosition = new Vector3();
  private goalYaw = 0;
  private goalScale = 1;
  private xDamper = new Damper();
  private yDamper = new Damper();
  private zDamper = new Damper();
  private yawDamper = new Damper();
  private scaleDamper = new Damper();

  private onExitWebXRButtonContainerClick = () => this.stopPresenting();

  constructor(private renderer: Renderer) {
    super();
    this.threeRenderer = renderer.threeRenderer;
    this.threeRenderer.xr.enabled = true;
  }

  async resolveARSession(scene: ModelScene): Promise<XRSession> {
    assertIsArCandidate();


    const session: XRSession =
        await navigator.xr!.requestSession!('immersive-ar', {
          requiredFeatures: ['hit-test'],
          optionalFeatures: ['dom-overlay'],
          domOverlay:
              {root: scene.element.shadowRoot!.querySelector('div.default')}
        });

    this.threeRenderer.xr.setReferenceSpaceType('local');

    await this.threeRenderer.xr.setSession(session as any);

    scene.element[$onResize](window.screen);

    return session;
  }

  /**
   * The currently presented scene, if any
   */
  get presentedScene() {
    return this._presentedScene;
  }

  /**
   * Resolves to true if the renderer has detected all the necessary qualities
   * to support presentation in AR.
   */
  async supportsPresentation() {
    try {
      assertIsArCandidate();
      return await navigator.xr!.isSessionSupported('immersive-ar');
    } catch (error) {
      return false;
    }
  }

  /**
   * Present a scene in AR
   */
  async present(scene: ModelScene): Promise<void> {
    if (this.isPresenting) {
      console.warn('Cannot present while a model is already presenting');
    }

    let waitForAnimationFrame = new Promise<void>((resolve, _reject) => {
      requestAnimationFrame(() => resolve());
    });

    scene.setHotspotsVisibility(false);
    scene.isDirty = true;
    // Render a frame to turn off the hotspots
    await waitForAnimationFrame;

    // This sets isPresenting to true
    this._presentedScene = scene;

    const currentSession = await this.resolveARSession(scene);

    currentSession.addEventListener('end', () => {
      this.postSessionCleanup();
    }, {once: true});

    const exitButton = scene.element.shadowRoot!.querySelector(
                           '.slot.exit-webxr-ar-button') as HTMLElement;
    exitButton.classList.add('enabled');
    exitButton.addEventListener('click', this.onExitWebXRButtonContainerClick);
    this.exitWebXRButtonContainer = exitButton;

    const viewerRefSpace = await currentSession.requestReferenceSpace('viewer');

    this.initialized = false;

    this.turntableRotation = scene.yaw;
    this.goalYaw = scene.yaw;
    this.goalScale = 1;

    this.oldBackground = scene.background;
    scene.background = null;

    this.oldShadowIntensity = scene.shadowIntensity;
    scene.setShadowIntensity(0);

    this.oldTarget.copy(scene.getTarget());

    scene.addEventListener('model-load', this.onUpdateScene);

    const radians = HIT_ANGLE_DEG * Math.PI / 180;
    const ray = this.placeOnWall === true ?
        undefined :
        new XRRay(
            new DOMPoint(0, 0, 0),
            {x: 0, y: -Math.sin(radians), z: -Math.cos(radians)});
    currentSession.requestHitTestSource({space: viewerRefSpace, offsetRay: ray})
        .then(hitTestSource => {
          this.initialHitSource = hitTestSource;
        });

    this.currentSession = currentSession;
    this.placementBox =
        new PlacementBox(scene, this.placeOnWall ? 'back' : 'bottom');
    this.placementComplete = false;
    this.xDamper.setDecayTime(INTRO_DECAY);
    this.yDamper.setDecayTime(INTRO_DECAY);
    this.zDamper.setDecayTime(INTRO_DECAY);

    this.lastTick = performance.now();
  }

  /**
   * If currently presenting a scene in AR, stops presentation and exits AR.
   */
  async stopPresenting() {
    if (!this.isPresenting) {
      return;
    }

    const cleanupPromise = new Promise((resolve) => {
      this.resolveCleanup = resolve;
    });

    try {
      await this.currentSession!.end();
      await cleanupPromise;
    } catch (error) {
      console.warn('Error while trying to end AR session');
      console.warn(error);

      this.postSessionCleanup();
    }
  }

  /**
   * True if a scene is currently in the process of being presented in AR
   */
  get isPresenting(): boolean {
    return this.presentedScene != null;
  }

  get target(): Vector3 {
    return this.oldTarget;
  }

  updateTarget() {
    const scene = this.presentedScene;
    if (scene != null) {
      const target = scene.getTarget();
      this.oldTarget.copy(target);
      if (this.placeOnWall) {
        // Move the scene's target to the center of the back of the model's
        // bounding box.
        scene.setTarget(target.x, target.y, scene.boundingBox.min.z);
      } else {
        // Move the scene's target to the model's floor height.
        scene.setTarget(target.x, scene.boundingBox.min.y, target.z);
      }
    }
  }

  onUpdateScene = () => {
    if (this.placementBox != null && this.isPresenting) {
      this.placementBox!.dispose();
      this.placementBox = new PlacementBox(
          this.presentedScene!, this.placeOnWall ? 'back' : 'bottom');
    }
  };

  private postSessionCleanup() {
    const session = this.currentSession;
    if (session != null) {
      session.removeEventListener('selectstart', this.onSelectStart);
      session.removeEventListener('selectend', this.onSelectEnd);
      session.cancelAnimationFrame(this.rafId!);
      this.currentSession = null;
    }

    const scene = this.presentedScene;
    if (scene != null) {
      const {element} = scene;
      scene.setCamera(scene.camera);

      scene.position.set(0, 0, 0);
      scene.scale.set(1, 1, 1);
      scene.setShadowScaleAndOffset(1, 0);
      const yaw = this.turntableRotation;
      if (yaw != null) {
        scene.yaw = yaw;
      }
      const intensity = this.oldShadowIntensity;
      if (intensity != null) {
        scene.setShadowIntensity(intensity);
      }
      const background = this.oldBackground;
      if (background != null) {
        scene.background = background;
      }
      const point = this.oldTarget;
      scene.setTarget(point.x, point.y, point.z);

      scene.removeEventListener('model-load', this.onUpdateScene);
      scene.orientHotspots(0);
      element.requestUpdate('cameraTarget');
      element.requestUpdate('maxCameraOrbit');
      element[$onResize](element.getBoundingClientRect());
    }

    // Force the Renderer to update its size
    this.renderer.height = 0;

    const exitButton = this.exitWebXRButtonContainer;
    if (exitButton != null) {
      exitButton.classList.remove('enabled');
      exitButton.removeEventListener(
          'click', this.onExitWebXRButtonContainerClick);
      this.exitWebXRButtonContainer = null;
    }

    const hitSource = this.transientHitTestSource;
    if (hitSource != null) {
      hitSource.cancel();
      this.transientHitTestSource = null;
    }

    const hitSourceInitial = this.initialHitSource;
    if (hitSourceInitial != null) {
      hitSourceInitial.cancel();
      this.initialHitSource = null;
    }

    if (this.placementBox != null) {
      this.placementBox!.dispose();
      this.placementBox = null;
    }

    this.lastTick = null;
    this.turntableRotation = null;
    this.oldShadowIntensity = null;
    this.oldBackground = null;
    this.rafId = null;
    this._presentedScene = null;
    this.frame = null;
    this.inputSource = null;

    if (this.resolveCleanup != null) {
      this.resolveCleanup!();
    }

    this.dispatchEvent({type: 'status', status: ARStatus.NOT_PRESENTING});
  }

  private updateView(view: XRView) {
    const viewMatrix = view.transform.matrix;

    const scene = this.presentedScene!;
    scene.camera.near = 0.1;
    scene.camera.far = 100;

    this.presentedScene!.orientHotspots(
        Math.atan2(viewMatrix[1], viewMatrix[5]));

    this.cameraPosition.set(viewMatrix[12], viewMatrix[13], viewMatrix[14]);

    if (!this.initialized) {
      const {position, element} = scene;
      const {theta, radius} =
          (element as ModelViewerElementBase & ControlsInterface)
              .getCameraOrbit();
      // Orient model to match the 3D camera view
      const cameraDirection =
          vector3.set(viewMatrix[8], viewMatrix[9], viewMatrix[10]);
      scene.yaw = Math.atan2(cameraDirection.x, cameraDirection.z) - theta;
      this.goalYaw = scene.yaw;

      position.copy(this.cameraPosition)
          .add(cameraDirection.multiplyScalar(-1 * radius));
      this.goalPosition.copy(position);

      scene.setHotspotsVisibility(true);
      this.initialized = true;
      this.dispatchEvent({type: 'status', status: ARStatus.SESSION_STARTED});
    }

    // Use automatic dynamic viewport scaling if supported.
    if (view.requestViewportScale && view.recommendedViewportScale) {
      const scale = view.recommendedViewportScale;
      view.requestViewportScale(Math.max(scale, MIN_VIEWPORT_SCALE));
    }
    const layer = this.currentSession!.renderState.baseLayer;
    const viewport = layer!.getViewport(view);
    this.threeRenderer.setViewport(
        viewport.x, viewport.y, viewport.width, viewport.height);
  }

  private placeInitially(frame: XRFrame) {
    const hitSource = this.initialHitSource;
    if (hitSource == null) {
      return;
    }

    const hitTestResults = frame.getHitTestResults(hitSource);
    if (hitTestResults.length == 0) {
      return;
    }

    const hit = hitTestResults[0];
    const hitPoint = this.getHitPoint(hit);
    if (hitPoint == null) {
      return;
    }

    this.placeModel(hitPoint);

    hitSource.cancel();
    this.initialHitSource = null;

    const {session} = frame;
    session.addEventListener('selectstart', this.onSelectStart);
    session.addEventListener('selectend', this.onSelectEnd);
    session
        .requestHitTestSourceForTransientInput({profile: 'generic-touchscreen'})
        .then(hitTestSource => {
          this.transientHitTestSource = hitTestSource;
        });
  }

  private getHitPoint(hitResult: XRHitTestResult): Vector3|null {
    const refSpace = this.threeRenderer.xr.getReferenceSpace()!;
    const pose = hitResult.getPose(refSpace);
    if (pose == null) {
      return null;
    }

    const hitMatrix = matrix4.fromArray(pose.transform.matrix);

    if (this.placeOnWall === true) {
      // Orient the model to the wall's normal vector.
      this.goalYaw = Math.atan2(hitMatrix.elements[4], hitMatrix.elements[6]);
    }
    // Check that the y-coordinate of the normal is large enough that the normal
    // is pointing up for floor placement; opposite for wall placement.
    return hitMatrix.elements[5] > 0.75 !== this.placeOnWall ?
        hitPosition.setFromMatrixPosition(hitMatrix) :
        null;
  }

  public placeModel(hit: Vector3) {
    this.placementBox!.show = true;

    if (this.placeOnWall) {
      this.goalPosition.copy(hit);
    } else {
      this.goalPosition.y = hit.y;
    }

    this.updateTarget();

    this.dispatchEvent({type: 'status', status: ARStatus.OBJECT_PLACED});
  }

  private onSelectStart = (event: Event) => {
    const hitSource = this.transientHitTestSource;
    if (hitSource == null) {
      return;
    }
    const fingers = this.frame!.getHitTestResultsForTransientInput(hitSource);
    const scene = this.presentedScene!;
    const box = this.placementBox!;

    if (fingers.length === 1) {
      this.inputSource = (event as XRInputSourceEvent).inputSource;
      const {axes} = this.inputSource!.gamepad;

      const hitPosition = box.getHit(this.presentedScene!, axes[0], axes[1]);
      box.show = true;

      if (hitPosition != null) {
        this.isTranslating = true;
        this.lastDragPosition.copy(hitPosition);
      } else if (this.placeOnWall === false) {
        this.isRotating = true;
        this.lastScalar = axes[0];
      }
    } else if (fingers.length === 2 && scene.canScale) {
      box.show = true;
      this.isScaling = true;
      this.lastScalar = this.fingerSeparation(fingers) / scene.scale.x;
    }
  };

  private onSelectEnd = () => {
    this.isTranslating = false;
    this.isRotating = false;
    this.isScaling = false;
    this.inputSource = null;
    this.goalPosition.y +=
        this.placementBox!.offsetHeight * this.presentedScene!.scale.x;
    this.placementBox!.show = false
  };

  private fingerSeparation(fingers: XRTransientInputHitTestResult[]): number {
    const fingerOne = fingers[0].inputSource.gamepad.axes;
    const fingerTwo = fingers[1].inputSource.gamepad.axes;
    const deltaX = fingerTwo[0] - fingerOne[0];
    const deltaY = fingerTwo[1] - fingerOne[1];
    return Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  }

  private processInput(frame: XRFrame) {
    const hitSource = this.transientHitTestSource;
    if (hitSource == null) {
      return;
    }
    if (!this.isTranslating && !this.isScaling && !this.isRotating) {
      return;
    }
    const fingers = frame.getHitTestResultsForTransientInput(hitSource);
    const scene = this.presentedScene!;
    const scale = scene.scale.x;

    // Rotating, translating and scaling are mutually exclusive operations; only
    // one can happen at a time, but we can switch during a gesture.
    if (this.isScaling) {
      if (fingers.length < 2) {
        // If we lose the second finger, stop scaling (in fact, stop processing
        // input altogether until a new gesture starts).
        this.isScaling = false;
      } else {
        const separation = this.fingerSeparation(fingers);
        const scale = separation / this.lastScalar;
        this.goalScale =
            (scale < SCALE_SNAP_HIGH && scale > SCALE_SNAP_LOW) ? 1 : scale;
      }
      return;
    } else if (fingers.length === 2 && scene.canScale) {
      // If we were rotating or translating and we get a second finger, switch
      // to scaling instead.
      this.isTranslating = false;
      this.isRotating = false;
      this.isScaling = true;
      this.lastScalar = this.fingerSeparation(fingers) / scale;
      return;
    }

    if (this.isRotating) {
      const thisDragX = this.inputSource!.gamepad.axes[0];
      this.goalYaw += (thisDragX - this.lastScalar) * ROTATION_RATE;
      this.lastScalar = thisDragX;
    } else if (this.isTranslating) {
      fingers.forEach(finger => {
        if (finger.inputSource !== this.inputSource ||
            finger.results.length < 1) {
          return;
        }

        const hit = this.getHitPoint(finger.results[0]);
        if (hit == null) {
          return;
        }

        this.goalPosition.sub(this.lastDragPosition);

        if (this.placeOnWall === false) {
          const offset = hit.y - this.lastDragPosition.y;
          // When a lower floor is found, keep the model at the same height, but
          // drop the placement box to the floor. The model falls on select end.
          if (offset < 0) {
            this.placementBox!.offsetHeight = offset / scale;
            this.presentedScene!.setShadowScaleAndOffset(scale, offset);
            // Interpolate hit ray up to drag plane
            const cameraPosition = vector3.copy(this.cameraPosition);
            const alpha = -offset / (cameraPosition.y - hit.y);
            cameraPosition.multiplyScalar(alpha);
            hit.multiplyScalar(1 - alpha).add(cameraPosition);
          }
        }

        this.goalPosition.add(hit);
        this.lastDragPosition.copy(hit);
      });
    }
  }

  private moveScene(delta: number) {
    const scene = this.presentedScene!;
    const {position, yaw, idealCameraDistance: radius} = scene;
    const goal = this.goalPosition;
    const oldScale = scene.scale.x;
    const box = this.placementBox!;

    if (this.initialHitSource == null &&
        (!goal.equals(position) || this.goalScale !== oldScale)) {
      let {x, y, z} = position;
      x = this.xDamper.update(x, goal.x, delta, radius);
      y = this.yDamper.update(y, goal.y, delta, radius);
      z = this.zDamper.update(z, goal.z, delta, radius);
      position.set(x, y, z);

      const newScale =
          this.scaleDamper.update(oldScale, this.goalScale, delta, 1);
      scene.scale.set(newScale, newScale, newScale);

      if (!this.isTranslating) {
        const offset = goal.y - y;
        if (this.placementComplete && this.placeOnWall === false) {
          box.offsetHeight = offset / newScale;
          scene.setShadowScaleAndOffset(newScale, offset);
        } else if (offset === 0) {
          this.placementComplete = true;
          box.show = false;
          scene.setShadowIntensity(AR_SHADOW_INTENSITY);
          this.xDamper.setDecayTime(DECAY_MILLISECONDS);
          this.yDamper.setDecayTime(DECAY_MILLISECONDS);
          this.zDamper.setDecayTime(DECAY_MILLISECONDS);
        }
      }
    }
    box.updateOpacity(delta);
    scene.updateTarget(delta);
    // yaw must be updated last, since this also updates the shadow position.
    scene.yaw = this.yawDamper.update(yaw, this.goalYaw, delta, Math.PI);
  }

  /**
   * Only public to make it testable.
   */
  public onWebXRFrame(time: number, frame: XRFrame) {
    this.frame = frame;
    const refSpace = this.threeRenderer.xr.getReferenceSpace()!;
    const pose = frame.getViewerPose(refSpace);

    const scene = this.presentedScene;
    if (pose == null || scene == null || !scene.element[$sceneIsReady]()) {
      this.threeRenderer.clear();
      return;
    }

    // WebXR may return multiple views, i.e. for headset AR. This
    // isn't really supported at this point, but make a best-effort
    // attempt to render other views also, using the first view
    // as the main viewpoint.
    let isFirstView: boolean = true;
    for (const view of pose.views) {
      this.updateView(view);

      if (isFirstView) {
        this.placeInitially(frame);

        this.processInput(frame);

        const delta = time - this.lastTick!;
        this.moveScene(delta);
        this.renderer.preRender(scene, time, delta);
        this.lastTick = time;
      }

      // TODO: This is a workaround for a Chrome bug, which should be fixed
      // soon: https://bugs.chromium.org/p/chromium/issues/detail?id=1184085
      const gl = this.threeRenderer.getContext();
      gl.depthMask(false);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.depthMask(true);

      this.threeRenderer.render(scene, scene.camera);
      isFirstView = false;
    }
  }
}
