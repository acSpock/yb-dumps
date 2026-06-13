import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import * as MediaLibrary from 'expo-media-library';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';

import { buildRankingResult, createProjectFromPickedAssets, createSampleProject } from './src/data/sampleProject';
import { rankTripPhotos } from './src/services/analysisApi';
import {
  API_BASE_URL,
  disconnectInstagram,
  getInstagramStatus,
  importInstagramFeed,
  instagramAuthStartUrl,
  InstagramApiError,
  publishInstagramCarousel,
} from './src/services/instagramApi';
import {
  CarouselSlide,
  CarouselVariation,
  ExportStatus,
  FeedImportAsset,
  FeedImportState,
  FeedPreviewCandidate,
  InstagramConnectionState,
  InstagramPublishResult,
  RankedPick,
  RankingResult,
  TripPhoto,
  TripProject,
} from './src/types';

WebBrowser.maybeCompleteAuthSession();

type Screen = 'welcome' | 'library' | 'import' | 'analyzing' | 'results';
type ResultTab = 'carousel' | 'feed';
type PermissionState = 'unknown' | 'granted' | 'limited' | 'denied';

const SAVED_TRIPS_KEY = 'trip-picks:saved-trips:v1';
const DEVICE_SESSION_KEY = 'trip-picks:device-session-id:v1';

const disconnectedInstagram: InstagramConnectionState = {
  status: 'not_connected',
  publishCapability: {
    status: 'unknown',
  },
  shareStatus: 'not_started',
};

const analysisSteps = [
  { label: 'Preparing the trip dump', detail: 'Reading selected photos and creating analysis records.' },
  { label: 'Calling the ranker', detail: 'Sending photo metadata to the server-side curation engine.' },
  { label: 'Ranking the strongest 50', detail: 'Scoring quality, moments, people, place, and variety.' },
  { label: 'Composing carousel options', detail: 'Building finished edits with single-photo and multi-photo slides.' },
  { label: 'Checking feed preview', detail: 'Finding the photo that fits a warm, low-contrast grid.' },
  { label: 'Packaging choices', detail: 'Creating a small set of options to choose from.' },
];

type ExportVariationResult = {
  status: ExportStatus;
  savedCount: number;
  message: string;
};

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function queryParamValue(
  queryParams: Linking.ParsedURL['queryParams'],
  key: string,
) {
  const value = queryParams?.[key];

  if (Array.isArray(value)) {
    return String(value[0] ?? '');
  }

  return value ? String(value) : '';
}

function isInstagramCallbackUrl(url: string) {
  const parsed = Linking.parse(url);
  return parsed.path === 'instagram-callback' || url.includes('/instagram-callback');
}

function completedJobForResult(project: TripProject, result: RankingResult) {
  const now = new Date().toISOString();

  return {
    ...project.job,
    completedAt: result.generatedAt,
    progress: 1,
    resultId: result.resultId,
    stage: 'complete' as const,
    startedAt: project.job.startedAt ?? now,
    status: 'succeeded' as const,
    updatedAt: result.generatedAt,
  };
}

function runningJobForProject(project: TripProject) {
  const now = new Date().toISOString();

  return {
    ...project.job,
    progress: 0.1,
    stage: 'ingest' as const,
    startedAt: now,
    status: 'running' as const,
    updatedAt: now,
  };
}

async function readLocalSecret(key: string) {
  try {
    if (Platform.OS !== 'web' && (await SecureStore.isAvailableAsync())) {
      return SecureStore.getItemAsync(key);
    }
  } catch {
    // Fall back to AsyncStorage for Expo web and simulator edge cases.
  }

  return AsyncStorage.getItem(key);
}

async function writeLocalSecret(key: string, value: string) {
  try {
    if (Platform.OS !== 'web' && (await SecureStore.isAvailableAsync())) {
      await SecureStore.setItemAsync(key, value);
      return;
    }
  } catch {
    // Fall back to AsyncStorage for Expo web and simulator edge cases.
  }

  await AsyncStorage.setItem(key, value);
}

async function getOrCreateDeviceSessionId() {
  const existingSessionId = await readLocalSecret(DEVICE_SESSION_KEY);

  if (existingSessionId) {
    return existingSessionId;
  }

  const nextSessionId = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  await writeLocalSecret(DEVICE_SESSION_KEY, nextSessionId);
  return nextSessionId;
}

function apiErrorMessage(error: unknown, fallback: string) {
  if (error instanceof InstagramApiError) {
    return `${fallback} ${error.message}`;
  }

  if (error instanceof Error) {
    return `${fallback} ${error.message}`;
  }

  return fallback;
}

function instagramSettingsSummary(instagram: InstagramConnectionState) {
  if (instagram.status === 'setup_required') {
    return 'Meta app env vars are missing on the API.';
  }

  if (instagram.status === 'error') {
    return instagram.errorMessage ?? 'Instagram connection has an error.';
  }

  if (instagram.status !== 'connected') {
    return 'Personal accounts do not need a connection. Export is the default Instagram workflow.';
  }

  const accountLabel = instagram.accountType === 'professional' ? 'Creator/Business account' : 'personal account';
  const capability = instagram.publishCapability?.status;

  if (capability === 'available') {
    return `${instagram.username ? `@${instagram.username}` : 'Instagram'} connected with Creator API publishing available.`;
  }

  if (capability === 'requires_professional_account') {
    return `${instagram.username ? `@${instagram.username}` : 'Instagram'} connected as a ${accountLabel}. Use export unless this account is Creator/Business publish-eligible.`;
  }

  return `${instagram.username ? `@${instagram.username}` : 'Instagram'} connected as a ${accountLabel}.`;
}

function instagramForPublishResult(
  currentInstagram: InstagramConnectionState,
  result: InstagramPublishResult,
): InstagramConnectionState {
  if (result.status === 'published') {
    return {
      ...currentInstagram,
      shareStatus: 'published',
      publishCapability: {
        status: 'available',
        reason: result.message,
      },
    };
  }

  if (result.status === 'render_required') {
    return {
      ...currentInstagram,
      shareStatus: 'render_required',
      publishCapability: {
        status: 'requires_public_media',
        reason: result.message,
      },
    };
  }

  if (result.status === 'requires_export') {
    return {
      ...currentInstagram,
      shareStatus: 'requires_export',
      publishCapability: {
        status: 'requires_professional_account',
        reason: result.message,
      },
    };
  }

  return {
    ...currentInstagram,
    shareStatus: 'failed',
    errorMessage: result.message,
    publishCapability: {
      status: result.status === 'setup_required' ? 'setup_required' : 'unavailable',
      reason: result.message,
    },
  };
}

function renderedSlideUrlsForVariation(
  variation: CarouselVariation,
  photosById: Map<string, TripPhoto>,
) {
  const allSlidesAreSinglePublicImages = variation.slides.every((slide) => {
    const photo = photosById.get(slide.photoIds[0]);
    const uri = photo?.localUri ?? photo?.thumbnailUri ?? '';
    return slide.template === 'single' && uri.startsWith('https://');
  });

  if (!allSlidesAreSinglePublicImages) {
    return [];
  }

  return variation.slides
    .map((slide) => photosById.get(slide.photoIds[0])?.localUri ?? photosById.get(slide.photoIds[0])?.thumbnailUri ?? '')
    .filter((uri) => uri.startsWith('https://'));
}

function uniquePhotoUrisForVariation(variation: CarouselVariation, photosById: Map<string, TripPhoto>) {
  const uris = variation.slides.flatMap((slide) =>
    slide.photoIds.map((photoId) => {
      const photo = photosById.get(photoId);
      return photo?.localUri ?? photo?.thumbnailUri ?? '';
    }),
  );

  return Array.from(new Set(uris.filter(Boolean)));
}

function isLocalMediaUri(uri: string) {
  return uri.startsWith('file://') || uri.startsWith('ph://') || uri.startsWith('assets-library://');
}

async function exportVariationPhotos(
  variation: CarouselVariation,
  photosById: Map<string, TripPhoto>,
): Promise<ExportVariationResult> {
  const uris = uniquePhotoUrisForVariation(variation, photosById);
  const localUris = uris.filter(isLocalMediaUri);

  if (localUris.length === 0) {
    return {
      status: 'share_sheet_ready',
      savedCount: 0,
      message:
        'This edit needs rendered local slide files before Camera Roll export. For now, use picked phone photos rather than remote sample images.',
    };
  }

  try {
    const permission = await MediaLibrary.requestPermissionsAsync();

    if (!permission.granted) {
      return {
        status: 'share_sheet_ready',
        savedCount: 0,
        message: 'Photo save permission was denied. Use the native share sheet or grant add-only photo access.',
      };
    }

    let savedCount = 0;

    for (const uri of localUris) {
      await MediaLibrary.createAssetAsync(uri);
      savedCount += 1;
    }

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(localUris[0]);
    }

    return {
      status: 'saved_to_camera_roll',
      savedCount,
      message: `Saved ${savedCount} photos to Recents for Instagram export.`,
    };
  } catch (error) {
    return {
      status: 'share_sheet_ready',
      savedCount: 0,
      message: apiErrorMessage(error, 'Camera Roll export failed.'),
    };
  }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('welcome');
  const [project, setProject] = useState<TripProject | null>(null);
  const [permissionState, setPermissionState] = useState<PermissionState>('unknown');
  const [analysisStep, setAnalysisStep] = useState(0);
  const [activeTab, setActiveTab] = useState<ResultTab>('carousel');
  const [selectedVariationId, setSelectedVariationId] = useState<string | null>(null);
  const [savedProjects, setSavedProjects] = useState<TripProject[]>([]);
  const [storageStatus, setStorageStatus] = useState('Loading saved trips...');
  const [workflowMessage, setWorkflowMessage] = useState<string | null>(null);
  const [deviceSessionId, setDeviceSessionId] = useState<string | null>(null);
  const [instagram, setInstagram] = useState<InstagramConnectionState>(disconnectedInstagram);
  const [instagramStatusMessage, setInstagramStatusMessage] = useState('Instagram is not connected yet.');
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [lastInstagramAuthUrl, setLastInstagramAuthUrl] = useState<string | null>(null);

  const photosById = useMemo(() => {
    return new Map((project?.photos ?? []).map((photo) => [photo.photoId, photo]));
  }, [project]);

  useEffect(() => {
    let canceled = false;

    async function loadSavedProjects() {
      try {
        const rawValue = await AsyncStorage.getItem(SAVED_TRIPS_KEY);
        const parsedProjects = rawValue ? (JSON.parse(rawValue) as TripProject[]) : [];

        if (!canceled) {
          setSavedProjects(parsedProjects);
          setStorageStatus(
            parsedProjects.length === 0
              ? 'No saved trips yet.'
              : `${parsedProjects.length} saved ${parsedProjects.length === 1 ? 'trip' : 'trips'} on this device.`,
          );
        }
      } catch {
        if (!canceled) {
          setStorageStatus('Saved trips could not be loaded on this device.');
        }
      }
    }

    void loadSavedProjects();

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    function handleIncomingUrl(event: { url: string }) {
      if (!isInstagramCallbackUrl(event.url)) {
        return;
      }

      void handleInstagramCallbackUrl(event.url);
    }

    const subscription = Linking.addEventListener('url', handleIncomingUrl);

    void Linking.getInitialURL().then((url) => {
      if (url) {
        handleIncomingUrl({ url });
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    let canceled = false;

    async function initializeInstagramSession() {
      const sessionId = await getOrCreateDeviceSessionId();

      if (canceled) {
        return;
      }

      setDeviceSessionId(sessionId);
      await refreshInstagramConnection(sessionId, false);
    }

    void initializeInstagramSession();

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (screen !== 'analyzing' || !project) {
      return;
    }

    let canceled = false;
    setAnalysisStep(0);
    setWorkflowMessage(null);

    const timers = analysisSteps.map((_, index) =>
      setTimeout(() => {
        if (!canceled) {
          setAnalysisStep(index);
        }
      }, index * 720),
    );

    const completionTimer = setTimeout(() => {
      void (async () => {
        let result: RankingResult;
        let completionMessage = 'Server analysis complete. Carousel options were generated from the backend ranker.';

        try {
          result = await rankTripPhotos({
            feedImport: project.feedImport,
            jobId: project.job.jobId,
            photos: project.photos,
            projectId: project.projectId,
          });
        } catch (error) {
          result = buildRankingResult(project.projectId, project.photos);
          completionMessage = apiErrorMessage(error, 'Server analysis failed. Used local fallback ranking instead.');
        }

        if (canceled) {
          return;
        }

        const completedProject = {
          ...project,
          job: completedJobForResult(project, result),
          result,
          savedAt: project.savedAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const firstVariationId = completedProject.result.carouselVariations[0]?.variationId ?? null;

        setProject(completedProject);
        setSelectedVariationId((currentId) => currentId ?? firstVariationId);
        setActiveTab('carousel');
        setScreen('results');
        setWorkflowMessage(completionMessage);
        void saveProjectSnapshot(
          {
            ...completedProject,
            chosenCarouselVariationId: completedProject.chosenCarouselVariationId ?? firstVariationId ?? undefined,
          },
          false,
          completionMessage,
        );
      })();
    }, analysisSteps.length * 720 + 450);

    return () => {
      canceled = true;
      timers.forEach(clearTimeout);
      clearTimeout(completionTimer);
    };
  }, [project?.projectId, screen]);

  async function writeSavedProjects(nextProjects: TripProject[]) {
    setSavedProjects(nextProjects);
    await AsyncStorage.setItem(SAVED_TRIPS_KEY, JSON.stringify(nextProjects));
    setStorageStatus(
      nextProjects.length === 0
        ? 'No saved trips yet.'
        : `${nextProjects.length} saved ${nextProjects.length === 1 ? 'trip' : 'trips'} on this device.`,
    );
  }

  async function saveProjectSnapshot(
    nextProject: TripProject,
    syncCurrentProject = true,
    successMessage?: string,
  ) {
    const now = new Date().toISOString();
    const savedProject = {
      ...nextProject,
      savedAt: nextProject.savedAt ?? now,
      updatedAt: now,
    };
    const nextProjects = [
      savedProject,
      ...savedProjects.filter((savedProjectItem) => savedProjectItem.projectId !== savedProject.projectId),
    ];

    if (syncCurrentProject) {
      setProject(savedProject);
    }

    try {
      await writeSavedProjects(nextProjects);
      setWorkflowMessage(successMessage ?? `Saved ${savedProject.name} to this device.`);
    } catch {
      setWorkflowMessage('This device could not save the trip locally.');
    }
  }

  function openSavedProject(savedProject: TripProject) {
    const firstVariationId = savedProject.result.carouselVariations[0]?.variationId ?? null;

    setProject(savedProject);
    setSelectedVariationId(savedProject.chosenCarouselVariationId ?? firstVariationId);
    setActiveTab('carousel');
    setScreen('results');
    setWorkflowMessage(`Opened ${savedProject.name} from saved trips.`);
  }

  function selectVariation(variationId: string) {
    setSelectedVariationId(variationId);

    if (!project) {
      return;
    }

    const updatedProject = {
      ...project,
      chosenCarouselVariationId: variationId,
      updatedAt: new Date().toISOString(),
    };
    setProject(updatedProject);
    void saveProjectSnapshot(updatedProject, false);
  }

  function updateProjectWorkflow(updater: (currentProject: TripProject) => TripProject, message: string) {
    if (!project) {
      return;
    }

    const updatedProject = updater(project);
    setProject(updatedProject);
    setWorkflowMessage(message);
    void saveProjectSnapshot(updatedProject, false, message);
  }

  async function ensureDeviceSessionId() {
    if (deviceSessionId) {
      return deviceSessionId;
    }

    const sessionId = await getOrCreateDeviceSessionId();
    setDeviceSessionId(sessionId);
    return sessionId;
  }

  async function refreshInstagramConnection(sessionId?: string, showStatusMessage = true) {
    const nextSessionId = sessionId ?? (await ensureDeviceSessionId());

    if (showStatusMessage) {
      setInstagramStatusMessage('Checking Instagram connection...');
    }

    try {
      const nextInstagram = await getInstagramStatus(nextSessionId);
      setInstagram(nextInstagram);
      setInstagramStatusMessage(instagramSettingsSummary(nextInstagram));
      return nextInstagram;
    } catch (error) {
      const message = apiErrorMessage(error, 'Instagram status could not be loaded.');
      const nextInstagram: InstagramConnectionState = {
        status: 'error',
        errorMessage: message,
        publishCapability: {
          status: 'unavailable',
          reason: message,
        },
        shareStatus: 'failed',
      };

      setInstagram(nextInstagram);
      setInstagramStatusMessage(message);
      return nextInstagram;
    }
  }

  async function handleInstagramCallbackUrl(url: string, sessionId?: string) {
    if (!isInstagramCallbackUrl(url)) {
      return false;
    }

    const parsed = Linking.parse(url);
    const status = queryParamValue(parsed.queryParams, 'instagram_status');
    const errorMessage = queryParamValue(parsed.queryParams, 'instagram_error');

    setSettingsVisible(true);

    if (status === 'setup_required') {
      setInstagram({
        status: 'setup_required',
        publishCapability: {
          status: 'setup_required',
          reason: 'Add Meta app env vars to the API before connecting.',
        },
        shareStatus: 'failed',
      });
      setInstagramStatusMessage('Meta app env vars are missing on the API.');
      return true;
    }

    if (errorMessage) {
      setInstagram({
        status: 'error',
        errorMessage,
        publishCapability: {
          status: 'unavailable',
          reason: errorMessage,
        },
        shareStatus: 'failed',
      });
      setInstagramStatusMessage(errorMessage);
      return true;
    }

    const nextSessionId = sessionId ?? (await ensureDeviceSessionId());
    const nextInstagram = await refreshInstagramConnection(nextSessionId);

    if (nextInstagram.status === 'connected') {
      setWorkflowMessage(`Connected Instagram${nextInstagram.username ? ` as @${nextInstagram.username}` : ''}.`);
    }

    return true;
  }

  async function connectInstagram() {
    const sessionId = await ensureDeviceSessionId();
    const returnUrl = Linking.createURL('instagram-callback');
    const authUrl = instagramAuthStartUrl(sessionId, returnUrl);
    setLastInstagramAuthUrl(authUrl);

    setInstagramStatusMessage('Opening Meta Creator/Business login...');
    setWorkflowMessage('Opening Meta Creator/Business login...');

    try {
      if (Platform.OS !== 'web') {
        setSettingsVisible(false);
        await wait(250);
        setInstagramStatusMessage('Creator/Business login opened. Return to Trip Picks after approving access.');
        setWorkflowMessage('Creator/Business login opened in your browser. Return here after approving access.');
        const result = await WebBrowser.openBrowserAsync(authUrl);

        if (result.type === 'cancel' || result.type === 'dismiss') {
          setSettingsVisible(true);
          setInstagramStatusMessage('Creator/Business login was closed before returning to Trip Picks.');
        }

        return;
      }

      const result = await WebBrowser.openAuthSessionAsync(authUrl, returnUrl);

      if (result.type === 'cancel') {
        setInstagramStatusMessage('Creator/Business login was canceled.');
        return;
      }

      if (result.type === 'success') {
        const handled = await handleInstagramCallbackUrl(result.url, sessionId);

        if (handled) {
          return;
        }
      }

      if (result.type === 'dismiss') {
        setInstagramStatusMessage('Creator/Business login was dismissed.');
        setSettingsVisible(true);
        return;
      }

      const nextInstagram = await refreshInstagramConnection(sessionId);
      setSettingsVisible(true);

      if (nextInstagram.status === 'connected') {
        setWorkflowMessage(`Connected Instagram${nextInstagram.username ? ` as @${nextInstagram.username}` : ''}.`);
      }
    } catch (error) {
      const message = apiErrorMessage(error, 'Creator/Business login could not be opened.');
      setSettingsVisible(true);
      setInstagramStatusMessage(message);

      if (Platform.OS !== 'web') {
        Alert.alert('Creator/Business login did not open', message, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open API login',
            onPress: () => {
              void WebBrowser.openBrowserAsync(authUrl);
            },
          },
        ]);
      }
    }
  }

  async function openLastInstagramAuthUrl() {
    if (!lastInstagramAuthUrl) {
      return;
    }

    setInstagramStatusMessage('Opening Creator/Business login link...');

    try {
      if (Platform.OS !== 'web') {
        setSettingsVisible(false);
        await wait(250);
        await WebBrowser.openBrowserAsync(lastInstagramAuthUrl);
        return;
      }

      await Linking.openURL(lastInstagramAuthUrl);
    } catch (error) {
      setSettingsVisible(true);
      setInstagramStatusMessage(apiErrorMessage(error, 'Creator/Business login link could not be opened.'));
    }
  }

  async function disconnectInstagramAccount() {
    const sessionId = await ensureDeviceSessionId();
    setInstagramStatusMessage('Disconnecting Instagram...');

    try {
      const nextInstagram = await disconnectInstagram(sessionId);
      setInstagram(nextInstagram);
      setInstagramStatusMessage('Instagram disconnected.');
      setWorkflowMessage('Instagram disconnected from this device.');
    } catch (error) {
      setInstagramStatusMessage(apiErrorMessage(error, 'Instagram disconnect failed.'));
    }
  }

  async function updateExportStatus(status: ExportStatus, variationId?: string) {
    const selectedVariation = project?.result.carouselVariations.find(
      (variation) => variation.variationId === (variationId ?? selectedVariationId),
    );

    if (!selectedVariation) {
      return;
    }

    setSelectedVariationId(selectedVariation.variationId);

    const exportResult = await exportVariationPhotos(selectedVariation, photosById);
    const message =
      exportResult.status === 'saved_to_camera_roll'
        ? `Saved ${exportResult.savedCount} source photos to Recents. Rendered carousel slides will replace this once export rendering is built.`
        : exportResult.message;

    updateProjectWorkflow(
      (currentProject) => ({
        ...currentProject,
        chosenCarouselVariationId: selectedVariation.variationId,
        exportStatus: exportResult.status ?? status,
        updatedAt: new Date().toISOString(),
      }),
      message,
    );
  }

  async function useInstagramFeed() {
    if (instagram.status !== 'connected') {
      setSettingsVisible(true);
      setWorkflowMessage('Use a grid screenshot or selected recent posts for personal accounts. Creator/Business API connection is optional in Settings.');
      return;
    }

    const sessionId = await ensureDeviceSessionId();

    try {
      const { connection, feedImport } = await importInstagramFeed(sessionId);
      setInstagram(connection);
      setInstagramStatusMessage(instagramSettingsSummary(connection));

      if (!project) {
        setWorkflowMessage(`Imported ${feedImport.assets.length} Instagram posts. Open a trip to use them in feed preview.`);
        return;
      }

      updateProjectWorkflow(
        (currentProject) => ({
          ...currentProject,
          feedImport,
          instagram: connection,
          updatedAt: new Date().toISOString(),
        }),
        `Imported ${feedImport.assets.length} recent posts through the Creator/Business API for feed preview.`,
      );
    } catch (error) {
      const message = apiErrorMessage(error, 'Instagram feed import failed.');
      setWorkflowMessage(message);
      setInstagramStatusMessage(message);
    }
  }

  async function prepareInstagramPost(variationId: string) {
    const selectedVariation = project?.result.carouselVariations.find(
      (variation) => variation.variationId === variationId,
    );

    if (!project || !selectedVariation) {
      return;
    }

    const currentProject = project;

    setSelectedVariationId(variationId);

    if (instagram.status !== 'connected') {
      setSettingsVisible(true);
      setWorkflowMessage('Direct API publishing is only for connected Creator/Business accounts. Export is the personal-account path.');
      return;
    }

    const sessionId = await ensureDeviceSessionId();

    updateProjectWorkflow(
      (currentProject) => ({
        ...currentProject,
        chosenCarouselVariationId: variationId,
        instagram: {
          ...instagram,
          shareStatus: 'publishing',
        },
        updatedAt: new Date().toISOString(),
      }),
      `Checking Instagram publishing eligibility for ${selectedVariation.label}...`,
    );

    try {
      const publishResult = await publishInstagramCarousel({
        caption: `${currentProject.name} - ${selectedVariation.label}`,
        deviceSessionId: sessionId,
        mediaUrls: renderedSlideUrlsForVariation(selectedVariation, photosById),
        projectId: currentProject.projectId,
        variationId,
      });
      const nextInstagram = publishResult.connection ?? instagramForPublishResult(instagram, publishResult);

      setInstagram(nextInstagram);
      setInstagramStatusMessage(instagramSettingsSummary(nextInstagram));

      updateProjectWorkflow(
        (currentProject) => ({
          ...currentProject,
          chosenCarouselVariationId: variationId,
          instagram: nextInstagram,
          updatedAt: new Date().toISOString(),
        }),
        publishResult.message,
      );
    } catch (error) {
      const message = apiErrorMessage(error, 'Instagram publishing check failed.');
      const nextInstagram = {
        ...instagram,
        shareStatus: 'failed' as const,
        errorMessage: message,
      };
      setInstagram(nextInstagram);
      setInstagramStatusMessage(message);
      updateProjectWorkflow(
        (currentProject) => ({
          ...currentProject,
          instagram: nextInstagram,
          updatedAt: new Date().toISOString(),
        }),
        message,
      );
    }
  }

  function replaceCarouselSlidePhoto(
    variationId: string,
    slideId: string,
    photoIndex: number,
    replacementPhotoId: string,
  ) {
    const replacementPhoto = project?.photos.find((photo) => photo.photoId === replacementPhotoId);

    if (!replacementPhoto) {
      return;
    }

    updateProjectWorkflow(
      (currentProject) => ({
        ...currentProject,
        result: {
          ...currentProject.result,
          carouselVariations: currentProject.result.carouselVariations.map((variation) => {
            if (variation.variationId !== variationId) {
              return variation;
            }

            const nextSlides = variation.slides.map((slide) => {
              if (slide.slideId !== slideId) {
                return slide;
              }

              return {
                ...slide,
                photoIds: slide.photoIds.map((photoId, index) =>
                  index === photoIndex ? replacementPhotoId : photoId,
                ),
              };
            });
            const firstPhotoId = nextSlides[0]?.photoIds[0] ?? variation.coverPhotoId;
            const uniquePhotoIds = new Set(nextSlides.flatMap((slide) => slide.photoIds));

            return {
              ...variation,
              coverPhotoId: firstPhotoId,
              photoCount: uniquePhotoIds.size,
              slides: nextSlides,
            };
          }),
        },
        updatedAt: new Date().toISOString(),
      }),
      `Replaced a slide image with ${replacementPhoto.originalFilename ?? 'another trip photo'}.`,
    );
  }

  async function pickFeedSource(mode: 'screenshot' | 'recent_posts') {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: mode === 'recent_posts',
        orderedSelection: mode === 'recent_posts',
        selectionLimit: mode === 'recent_posts' ? 18 : 1,
        quality: 0.85,
      });

      if (result.canceled || result.assets.length === 0) {
        return;
      }

      const assets: FeedImportAsset[] = result.assets.map((asset, index) => ({
        id: asset.assetId ?? `${mode}-${Date.now()}-${index}`,
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
      }));
      const feedImport: FeedImportState = {
        mode,
        assets,
        importedAt: new Date().toISOString(),
      };
      const message =
        mode === 'screenshot'
          ? 'Imported a grid screenshot for feed preview.'
          : `Imported ${assets.length} recent posts for feed preview.`;

      updateProjectWorkflow(
        (currentProject) => ({
          ...currentProject,
          feedImport,
          updatedAt: new Date().toISOString(),
        }),
        message,
      );
    } catch (error) {
      Alert.alert('Feed import failed', error instanceof Error ? error.message : 'Try another feed source.');
    }
  }

  async function pickPhotos() {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(false);
      const nextPermissionState =
        permission.accessPrivileges === 'limited' ? 'limited' : permission.granted ? 'granted' : 'denied';
      setPermissionState(nextPermissionState);

      if (!permission.granted && permission.accessPrivileges !== 'limited') {
        Alert.alert('Photo access needed', 'Choose selected photo access to build carousel options.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        orderedSelection: true,
        selectionLimit: 0,
        quality: 0.85,
      });

      if (result.canceled || result.assets.length === 0) {
        return;
      }

      const pickedProject = createProjectFromPickedAssets(result.assets);
      setProject(pickedProject);
      setSelectedVariationId(null);
      setScreen('import');
    } catch (error) {
      Alert.alert('Photo picker failed', error instanceof Error ? error.message : 'Try again from the sample trip.');
    }
  }

  function loadSampleTrip() {
    const sampleProject = createSampleProject();
    setProject(sampleProject);
    setPermissionState('granted');
    setSelectedVariationId(sampleProject.result.carouselVariations[0]?.variationId ?? null);
    setScreen('import');
  }

  function startAnalysis() {
    const nextProject = project ?? createSampleProject();
    setProject({
      ...nextProject,
      job: runningJobForProject(nextProject),
      updatedAt: new Date().toISOString(),
    });
    setWorkflowMessage('Starting server-side analysis...');
    setScreen('analyzing');
  }

  const content = (() => {
    if (screen === 'welcome') {
      return (
        <WelcomeScreen
          savedTripCount={savedProjects.length}
          storageStatus={storageStatus}
          onOpenSettings={() => setSettingsVisible(true)}
          onOpenLibrary={() => {
            setScreen('library');
          }}
          onPlanTrip={() => {
            setScreen('import');
          }}
          onUseSample={loadSampleTrip}
        />
      );
    }

    if (screen === 'library') {
      return (
        <SavedTripsScreen
          savedProjects={savedProjects}
          storageStatus={storageStatus}
          onOpenSettings={() => setSettingsVisible(true)}
          onNewTrip={() => {
            setScreen('import');
          }}
          onOpenTrip={openSavedProject}
        />
      );
    }

    if (screen === 'import') {
      return (
        <ImportScreen
          permissionState={permissionState}
          project={project}
          onAnalyze={startAnalysis}
          onOpenSettings={() => setSettingsVisible(true)}
          onOpenLibrary={() => {
            setScreen('library');
          }}
          onPickPhotos={pickPhotos}
          onUseSample={loadSampleTrip}
        />
      );
    }

    if (screen === 'analyzing') {
      return (
        <AnalyzeScreen
          project={project}
          stepIndex={analysisStep}
        />
      );
    }

    return (
      <ResultsScreen
        activeTab={activeTab}
        instagram={instagram}
        photosById={photosById}
        project={project}
        selectedVariationId={selectedVariationId}
        onSelectTab={setActiveTab}
        onSelectVariation={selectVariation}
        onOpenSettings={() => setSettingsVisible(true)}
        onOpenLibrary={() => {
          setScreen('library');
        }}
        onImportFeedSource={pickFeedSource}
        onPrepareInstagramPost={prepareInstagramPost}
        onReplaceSlidePhoto={replaceCarouselSlidePhoto}
        onUpdateExportStatus={updateExportStatus}
        onUseInstagramFeed={useInstagramFeed}
        onStartNew={() => {
          setScreen('import');
        }}
        workflowMessage={workflowMessage}
      />
    );
  })();

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      {content}
      <SettingsModal
        apiBaseUrl={API_BASE_URL}
        deviceSessionId={deviceSessionId}
        instagram={instagram}
        lastAuthUrl={lastInstagramAuthUrl}
        statusMessage={instagramStatusMessage}
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
        onConnect={connectInstagram}
        onDisconnect={disconnectInstagramAccount}
        onOpenAuthUrl={openLastInstagramAuthUrl}
        onRefresh={() => void refreshInstagramConnection(undefined, true)}
        onRefreshFeed={useInstagramFeed}
      />
    </SafeAreaView>
  );
}

function HeaderSettingsButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel="Open settings"
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.headerSettingsButton, pressed && styles.buttonPressed]}
    >
      <Text style={styles.headerSettingsIcon}>{'\u2699'}</Text>
    </Pressable>
  );
}

function SettingsModal({
  apiBaseUrl,
  deviceSessionId,
  instagram,
  lastAuthUrl,
  statusMessage,
  visible,
  onClose,
  onConnect,
  onDisconnect,
  onOpenAuthUrl,
  onRefresh,
  onRefreshFeed,
}: {
  apiBaseUrl: string;
  deviceSessionId: string | null;
  instagram: InstagramConnectionState;
  lastAuthUrl: string | null;
  statusMessage: string;
  visible: boolean;
  onClose: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenAuthUrl: () => void;
  onRefresh: () => void;
  onRefreshFeed: () => void;
}) {
  const connected = instagram.status === 'connected';
  const publishStatus = instagram.publishCapability?.status ?? 'unknown';

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      visible={visible}
    >
      <SafeAreaView style={styles.settingsModalBackdrop}>
        <ScrollView contentContainerStyle={styles.settingsPage}>
          <View style={styles.settingsHeader}>
            <View style={styles.flexText}>
              <Text style={styles.kicker}>Settings</Text>
              <Text style={styles.headerTitle}>Instagram export</Text>
              <Text style={styles.bodyText}>{statusMessage}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={styles.modalCloseButtonLight}
            >
              <Text style={styles.modalCloseButtonLightText}>Close</Text>
            </Pressable>
          </View>

          <View style={styles.settingsCard}>
            <View style={styles.summaryRow}>
              <View style={styles.flexText}>
                <Text style={styles.panelTitle}>{connected ? instagram.username ? `@${instagram.username}` : 'Connected account' : 'Personal export ready'}</Text>
                <Text style={styles.bodyText}>{instagramConnectionDetail(instagram)}</Text>
              </View>
              <View style={[styles.statusPill, instagram.status === 'error' && styles.statusPillError]}>
                <Text style={styles.statusPillText}>{instagram.status.replace(/_/g, ' ')}</Text>
              </View>
            </View>

            <View style={styles.settingsMetricGrid}>
              <SettingsMetric
                label="Account"
                value={instagram.accountType ?? 'unknown'}
              />
              <SettingsMetric
                label="Publish"
                value={publishStatus.replace(/_/g, ' ')}
              />
              <SettingsMetric
                label="Feed"
                value={instagram.importedMediaCount ? `${instagram.importedMediaCount} posts` : 'not imported'}
              />
              <SettingsMetric
                label="Session"
                value={deviceSessionId ? 'ready' : 'creating'}
              />
            </View>

            <Text style={styles.mutedText}>API: {apiBaseUrl}</Text>
          </View>

          <View style={styles.settingsCard}>
            <Text style={styles.panelTitle}>Optional Creator/Business connection</Text>
            <Text style={styles.bodyText}>
              Meta requires a professional Instagram account for API feed access and direct publishing. Everyday
              personal accounts should use export/share and manual feed import instead.
            </Text>
            <View style={styles.actionRow}>
              <PrimaryButton
                label={connected ? 'Reconnect Creator API' : 'Connect Creator/Business API'}
                onPress={onConnect}
              />
              <SecondaryButton
                label="Refresh status"
                onPress={onRefresh}
              />
              {connected ? (
                <SecondaryButton
                  label="Disconnect"
                  onPress={onDisconnect}
                />
              ) : null}
              {!connected && lastAuthUrl ? (
                <SecondaryButton
                  label="Open API login"
                  onPress={onOpenAuthUrl}
                />
              ) : null}
            </View>
          </View>

          <View style={styles.settingsCard}>
            <Text style={styles.panelTitle}>Feed and publishing</Text>
            <Text style={styles.bodyText}>
              Personal accounts use Camera Roll export and the native share sheet. API publishing appears only for
              Meta-approved Creator/Business accounts after rendered slide URLs are public.
            </Text>
            <View style={styles.actionRow}>
              <PrimaryButton
                label="Creator API feed import"
                onPress={onRefreshFeed}
              />
            </View>
            {instagram.lastFeedImportAt ? (
              <Text style={styles.mutedText}>Last feed import: {formatShortDate(instagram.lastFeedImportAt)}</Text>
            ) : null}
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function SettingsMetric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.settingsMetric}>
      <Text style={styles.settingsMetricLabel}>{label}</Text>
      <Text style={styles.settingsMetricValue}>{value}</Text>
    </View>
  );
}

function WelcomeScreen({
  savedTripCount,
  storageStatus,
  onOpenSettings,
  onOpenLibrary,
  onPlanTrip,
  onUseSample,
}: {
  savedTripCount: number;
  storageStatus: string;
  onOpenSettings: () => void;
  onOpenLibrary: () => void;
  onPlanTrip: () => void;
  onUseSample: () => void;
}) {
  const samplePhotos = createSampleProject().photos.slice(0, 7);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.screenTopBar}>
        <Text style={styles.topBarTitle}>Trip Picks</Text>
        <HeaderSettingsButton onPress={onOpenSettings} />
      </View>

      <View style={styles.heroBand}>
        <View style={styles.heroText}>
          <Text style={styles.kicker}>Trip Picks</Text>
          <Text style={styles.heroTitle}>Build the carousel. Preview the feed.</Text>
          <Text style={styles.heroCopy}>
            Select a trip dump, then get finished carousel options and a feed-fit recommendation without
            sorting every photo yourself.
          </Text>
        </View>

        <View style={styles.heroPreview}>
          {samplePhotos.map((photo, index) => (
            <Image
              key={photo.photoId}
              source={{ uri: photo.thumbnailUri ?? photo.localUri }}
              style={[styles.heroImage, index === 0 && styles.heroImageLarge]}
            />
          ))}
        </View>
      </View>

      <View style={styles.actionRow}>
        <PrimaryButton
          label="Build carousel options"
          onPress={onPlanTrip}
        />
        <SecondaryButton
          label={`Saved trips (${savedTripCount})`}
          onPress={onOpenLibrary}
        />
        <SecondaryButton
          label="Use sample trip"
          onPress={onUseSample}
        />
      </View>

      <View style={styles.storageNotice}>
        <Text style={styles.panelTitle}>Local library</Text>
        <Text style={styles.bodyText}>
          Generated trips are saved on this device so you can reopen carousel options and feed previews later.
        </Text>
        <Text style={styles.mutedText}>{storageStatus}</Text>
      </View>

      <View style={styles.promiseGrid}>
        <PromiseItem
          label="3 carousel edits"
          detail="Single-photo slides mixed with stacked multi-photo templates."
        />
        <PromiseItem
          label="Top 50 pool"
          detail="The strongest trip photos remain visible for trust and review."
        />
        <PromiseItem
          label="Feed preview"
          detail="Pick the image that fits the existing grid aesthetic."
        />
        <PromiseItem
          label="1,000-photo trip"
          detail="The product direction is built around large camera-roll dumps."
        />
      </View>
    </ScrollView>
  );
}

function SavedTripsScreen({
  savedProjects,
  storageStatus,
  onOpenSettings,
  onNewTrip,
  onOpenTrip,
}: {
  savedProjects: TripProject[];
  storageStatus: string;
  onOpenSettings: () => void;
  onNewTrip: () => void;
  onOpenTrip: (project: TripProject) => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.screenTopBar}>
        <Text style={styles.topBarTitle}>Trip Picks</Text>
        <HeaderSettingsButton onPress={onOpenSettings} />
      </View>

      <SectionHeader
        eyebrow="Library"
        title="Saved trips"
        copy="Generated trips live on this device so you can come back, compare carousel options, and export later."
      />

      <View style={styles.actionRow}>
        <PrimaryButton
          label="New trip"
          onPress={onNewTrip}
        />
      </View>

      <Text style={styles.mutedText}>{storageStatus}</Text>

      {savedProjects.length === 0 ? (
        <EmptyState
          title="No saved trips yet"
          copy="Generate carousel options from a trip and it will appear here automatically."
        />
      ) : (
        savedProjects.map((savedProject) => {
          const photosById = new Map(savedProject.photos.map((photo) => [photo.photoId, photo]));
          const chosenVariation =
            savedProject.result.carouselVariations.find(
              (variation) => variation.variationId === savedProject.chosenCarouselVariationId,
            ) ?? savedProject.result.carouselVariations[0];

          return (
            <View
              key={savedProject.projectId}
              style={styles.savedTripCard}
            >
              <View style={styles.summaryRow}>
                <View style={styles.flexText}>
                  <Text style={styles.sectionTitle}>{savedProject.name}</Text>
                  <Text style={styles.mutedText}>
                    {savedProject.photoCount.toLocaleString()} photos · saved {formatShortDate(savedProject.savedAt)}
                  </Text>
                </View>
                <View style={styles.statusPill}>
                  <Text style={styles.statusPillText}>{savedProject.exportStatus ? 'exported' : 'draft'}</Text>
                </View>
              </View>

              <PhotoStrip
                photoIds={chosenVariation?.slides.flatMap((slide) => slide.photoIds).slice(0, 10) ?? []}
                photosById={photosById}
              />

              <View style={styles.savedTripMeta}>
                <Text style={styles.panelTitle}>{chosenVariation?.label ?? 'Carousel options ready'}</Text>
                <Text style={styles.bodyText}>
                  {chosenVariation
                    ? `${chosenVariation.slideCount} slides · ${chosenVariation.photoCount} photos used`
                    : 'Open to review generated carousel options.'}
                </Text>
                <Text style={styles.mutedText}>
                  Feed source: {feedImportLabel(savedProject.feedImport)} · Export: {exportStatusLabel(savedProject.exportStatus)}
                </Text>
              </View>

              <PrimaryButton
                label="Open trip"
                onPress={() => onOpenTrip(savedProject)}
              />
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

function ImportScreen({
  permissionState,
  project,
  onAnalyze,
  onOpenSettings,
  onOpenLibrary,
  onPickPhotos,
  onUseSample,
}: {
  permissionState: PermissionState;
  project: TripProject | null;
  onAnalyze: () => void;
  onOpenSettings: () => void;
  onOpenLibrary: () => void;
  onPickPhotos: () => void;
  onUseSample: () => void;
}) {
  const visiblePhotos = project?.photos.slice(0, 21) ?? [];

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.screenTopBar}>
        <Text style={styles.topBarTitle}>Trip Picks</Text>
        <HeaderSettingsButton onPress={onOpenSettings} />
      </View>

      <SectionHeader
        eyebrow="Import"
        title="Start with the whole trip"
        copy="The goal is to pick from hundreds or thousands of photos and return finished carousel choices."
      />

      <View style={styles.permissionPanel}>
        <View style={styles.flexText}>
          <Text style={styles.panelTitle}>Photo access</Text>
          <Text style={styles.bodyText}>{permissionCopy(permissionState)}</Text>
        </View>
        <View style={[styles.statusPill, permissionState === 'denied' && styles.statusPillError]}>
          <Text style={styles.statusPillText}>{permissionState}</Text>
        </View>
      </View>

      <View style={styles.actionRow}>
        <PrimaryButton
          label="Choose trip photos"
          onPress={onPickPhotos}
        />
        <SecondaryButton
          label="Saved trips"
          onPress={onOpenLibrary}
        />
        <SecondaryButton
          label="Use sample trip"
          onPress={onUseSample}
        />
      </View>

      {project ? (
        <View style={styles.contentBlock}>
          <View style={styles.summaryRow}>
            <View style={styles.flexText}>
              <Text style={styles.sectionTitle}>{project.name}</Text>
              <Text style={styles.mutedText}>
                {project.photoCount.toLocaleString()} photos · {project.locationLabel}
              </Text>
            </View>
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeValue}>{project.photos.length}</Text>
              <Text style={styles.countBadgeLabel}>previewed</Text>
            </View>
          </View>

          <PhotoGrid photos={visiblePhotos} />

          <PrimaryButton
            label="Generate carousel options"
            onPress={onAnalyze}
          />
        </View>
      ) : (
        <EmptyState
          title="No trip selected"
          copy="Pick the full trip set when possible. The model should make the short list and carousel options for you."
        />
      )}
    </ScrollView>
  );
}

function AnalyzeScreen({ project, stepIndex }: { project: TripProject | null; stepIndex: number }) {
  const progress = (stepIndex + 1) / analysisSteps.length;
  const step = analysisSteps[stepIndex];

  return (
    <View style={styles.centerPage}>
      <View style={styles.analysisBox}>
        <ActivityIndicator
          color="#E4572E"
          size="large"
        />
        <Text style={styles.analysisTitle}>Creating options</Text>
        <Text style={styles.analysisStep}>{step.label}</Text>
        <Text style={styles.bodyText}>{step.detail}</Text>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
        <Text style={styles.mutedText}>
          {Math.round(progress * 100)}% · {project?.photoCount.toLocaleString() ?? 0} trip photos
        </Text>
      </View>
    </View>
  );
}

function ResultsScreen({
  activeTab,
  instagram,
  photosById,
  project,
  selectedVariationId,
  workflowMessage,
  onImportFeedSource,
  onOpenLibrary,
  onOpenSettings,
  onPrepareInstagramPost,
  onReplaceSlidePhoto,
  onSelectTab,
  onSelectVariation,
  onStartNew,
  onUpdateExportStatus,
  onUseInstagramFeed,
}: {
  activeTab: ResultTab;
  instagram: InstagramConnectionState;
  photosById: Map<string, TripPhoto>;
  project: TripProject | null;
  selectedVariationId: string | null;
  workflowMessage: string | null;
  onImportFeedSource: (mode: 'screenshot' | 'recent_posts') => void;
  onOpenLibrary: () => void;
  onOpenSettings: () => void;
  onPrepareInstagramPost: (variationId: string) => void;
  onReplaceSlidePhoto: (variationId: string, slideId: string, photoIndex: number, replacementPhotoId: string) => void;
  onSelectTab: (tab: ResultTab) => void;
  onSelectVariation: (variationId: string) => void;
  onStartNew: () => void;
  onUpdateExportStatus: (status: ExportStatus, variationId?: string) => void;
  onUseInstagramFeed: () => void;
}) {
  if (!project) {
    return (
      <View style={styles.centerPage}>
        <EmptyState
          title="No project loaded"
          copy="Start by selecting a trip or loading the sample trip."
        />
        <PrimaryButton
          label="Import photos"
          onPress={onStartNew}
        />
      </View>
    );
  }

  const selectedVariation =
    project.result.carouselVariations.find((variation) => variation.variationId === selectedVariationId) ??
    project.result.carouselVariations[0];

  return (
    <View style={styles.resultsShell}>
      <View style={styles.resultsHeader}>
        <View style={styles.flexText}>
          <Text style={styles.kicker}>Results</Text>
          <Text style={styles.headerTitle}>{project.name}</Text>
          <Text style={styles.mutedText}>
            {project.photoCount.toLocaleString()} photos · {project.result.modelVersion}
          </Text>
        </View>
        <View style={styles.headerActionRow}>
          <Pressable
            accessibilityRole="button"
            onPress={onOpenLibrary}
            style={styles.newTripButton}
          >
            <Text style={styles.newTripButtonText}>Library</Text>
          </Pressable>
          <HeaderSettingsButton onPress={onOpenSettings} />
        </View>
      </View>

      <View style={styles.tabRow}>
        <TabButton
          active={activeTab === 'carousel'}
          label="Carousel options"
          onPress={() => onSelectTab('carousel')}
        />
        <TabButton
          active={activeTab === 'feed'}
          label="Feed preview"
          onPress={() => onSelectTab('feed')}
        />
      </View>

      <ScrollView contentContainerStyle={styles.resultsContent}>
        {workflowMessage ? (
          <View style={styles.workflowNotice}>
            <Text style={styles.panelTitle}>Workflow update</Text>
            <Text style={styles.bodyText}>{workflowMessage}</Text>
          </View>
        ) : null}

        {activeTab === 'carousel' ? (
          <CarouselTab
            photosById={photosById}
            selectedVariation={selectedVariation}
            instagram={instagram}
            topPicks={project.result.topPicks}
            variations={project.result.carouselVariations}
            onPrepareInstagramPost={onPrepareInstagramPost}
            onReplaceSlidePhoto={onReplaceSlidePhoto}
            onSelectVariation={onSelectVariation}
            onStartNew={onStartNew}
            onUpdateExportStatus={onUpdateExportStatus}
            exportStatus={project.exportStatus}
          />
        ) : (
          <FeedPreviewTab
            candidates={project.result.feedPreviewCandidates}
            feedImport={project.feedImport}
            instagram={instagram}
            onImportFeedSource={onImportFeedSource}
            onUseInstagramFeed={onUseInstagramFeed}
            photos={project.photos}
            photosById={photosById}
          />
        )}
      </ScrollView>
    </View>
  );
}

function CarouselTab({
  exportStatus,
  instagram,
  photosById,
  selectedVariation,
  topPicks,
  variations,
  onPrepareInstagramPost,
  onReplaceSlidePhoto,
  onSelectVariation,
  onStartNew,
  onUpdateExportStatus,
}: {
  exportStatus?: ExportStatus;
  instagram?: InstagramConnectionState;
  photosById: Map<string, TripPhoto>;
  selectedVariation?: CarouselVariation;
  topPicks: RankedPick[];
  variations: CarouselVariation[];
  onPrepareInstagramPost: (variationId: string) => void;
  onReplaceSlidePhoto: (variationId: string, slideId: string, photoIndex: number, replacementPhotoId: string) => void;
  onSelectVariation: (variationId: string) => void;
  onStartNew: () => void;
  onUpdateExportStatus: (status: ExportStatus, variationId?: string) => void;
}) {
  const [previewVariationId, setPreviewVariationId] = useState<string | null>(null);
  const previewVariation =
    variations.find((variation) => variation.variationId === previewVariationId) ?? null;

  return (
    <View style={styles.contentBlock}>
      <SectionHeader
        eyebrow="Carousel"
        title="Choose one finished edit"
        copy="Tap an edit to open a full-screen carousel preview, then swipe through the generated slides."
      />

      {variations.map((variation) => (
        <CarouselOptionCard
          key={variation.variationId}
          photosById={photosById}
          selected={variation.variationId === selectedVariation?.variationId}
          variation={variation}
          onPress={() => setPreviewVariationId(variation.variationId)}
        />
      ))}

      <View style={styles.detailPanel}>
        <Text style={styles.panelTitle}>Top 50 candidate pool</Text>
        <Text style={styles.bodyText}>
          This stays mostly behind the scenes, but it helps explain where carousel choices came from.
        </Text>
        <PhotoStrip
          photoIds={topPicks.slice(0, 12).map((pick) => pick.photoId)}
          photosById={photosById}
        />
      </View>

      <CarouselPreviewModal
        exportStatus={exportStatus}
        instagram={instagram}
        photosById={photosById}
        replacementCandidates={topPicks}
        selectedVariationId={selectedVariation?.variationId}
        variation={previewVariation}
        onClose={() => setPreviewVariationId(null)}
        onPrepareInstagramPost={onPrepareInstagramPost}
        onReplaceSlidePhoto={onReplaceSlidePhoto}
        onSaveToCameraRoll={(variationId) => onUpdateExportStatus('saved_to_camera_roll', variationId)}
        onSelectVariation={(variationId) => {
          onSelectVariation(variationId);
          setPreviewVariationId(null);
        }}
        onStartNew={() => {
          setPreviewVariationId(null);
          onStartNew();
        }}
      />
    </View>
  );
}

function CarouselOptionCard({
  photosById,
  selected,
  variation,
  onPress,
}: {
  photosById: Map<string, TripPhoto>;
  selected: boolean;
  variation: CarouselVariation;
  onPress: () => void;
}) {
  const coverPhoto = photosById.get(variation.coverPhotoId);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.optionCard, selected && styles.optionCardSelected]}
    >
      {coverPhoto ? (
        <Image
          source={{ uri: coverPhoto.thumbnailUri ?? coverPhoto.localUri }}
          style={styles.optionCover}
        />
      ) : null}
      <View style={styles.optionBody}>
        <View style={styles.summaryRow}>
          <Text style={styles.panelTitle}>{variation.label}</Text>
          <View style={[styles.statusPill, selected && styles.statusPillSelected]}>
            <Text style={[styles.statusPillText, selected && styles.statusPillTextSelected]}>
              {selected ? 'chosen' : percent(variation.confidence)}
            </Text>
          </View>
        </View>
        <Text style={styles.bodyText}>{variation.thesis}</Text>
        <Text style={styles.mutedText}>
          {variation.slideCount} slides · {variation.photoCount} photos used
        </Text>
        <View style={styles.chipRow}>
          {variation.reasons.map((reason) => (
            <View
              key={reason}
              style={styles.chip}
            >
              <Text style={styles.chipText}>{reason}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.previewPrompt}>Tap to preview and swipe</Text>
      </View>
    </Pressable>
  );
}

function CarouselPreviewModal({
  exportStatus,
  instagram,
  photosById,
  replacementCandidates,
  selectedVariationId,
  variation,
  onClose,
  onPrepareInstagramPost,
  onReplaceSlidePhoto,
  onSaveToCameraRoll,
  onSelectVariation,
  onStartNew,
}: {
  exportStatus?: ExportStatus;
  instagram?: InstagramConnectionState;
  photosById: Map<string, TripPhoto>;
  replacementCandidates: RankedPick[];
  selectedVariationId?: string;
  variation: CarouselVariation | null;
  onClose: () => void;
  onPrepareInstagramPost: (variationId: string) => void;
  onReplaceSlidePhoto: (variationId: string, slideId: string, photoIndex: number, replacementPhotoId: string) => void;
  onSaveToCameraRoll: (variationId: string) => void;
  onSelectVariation: (variationId: string) => void;
  onStartNew: () => void;
}) {
  const { height, width } = useWindowDimensions();
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [isReplacing, setIsReplacing] = useState(false);
  const [replacementSlotIndex, setReplacementSlotIndex] = useState(0);
  const frameWidth = Math.min(width, 430);
  const artworkWidth = frameWidth - 32;
  const artworkHeight = Math.min(artworkWidth * 1.25, height * (isReplacing ? 0.38 : 0.55));
  const activeSlide = variation?.slides[activeSlideIndex];
  const isSelected = variation?.variationId === selectedVariationId;
  const canUseCreatorApi = instagram?.publishCapability?.status === 'available';

  useEffect(() => {
    setActiveSlideIndex(0);
    setIsReplacing(false);
    setReplacementSlotIndex(0);
  }, [variation?.variationId]);

  useEffect(() => {
    setIsReplacing(false);
    setReplacementSlotIndex(0);
  }, [activeSlide?.slideId]);

  function handleScrollEnd(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const nextIndex = Math.round(event.nativeEvent.contentOffset.x / frameWidth);
    const boundedIndex = Math.max(0, Math.min(nextIndex, (variation?.slides.length ?? 1) - 1));
    setActiveSlideIndex(boundedIndex);
  }

  if (!variation) {
    return null;
  }

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      visible
    >
      <SafeAreaView style={styles.carouselModalBackdrop}>
        <View style={[styles.carouselModalFrame, { width: frameWidth }]}>
          <View style={styles.carouselModalHeader}>
            <View style={styles.flexText}>
              <Text style={styles.modalKicker}>{variation.label}</Text>
              <Text style={styles.modalTitle}>Carousel preview</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={styles.modalCloseButton}
            >
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>

          <ScrollView
            horizontal
            pagingEnabled
            onMomentumScrollEnd={handleScrollEnd}
            scrollEventThrottle={16}
            showsHorizontalScrollIndicator={false}
            style={styles.modalSlidePager}
          >
            {variation.slides.map((slide) => (
              <View
                key={slide.slideId}
                style={[styles.modalSlidePage, { width: frameWidth }]}
              >
                <SlideArtwork
                  frameStyle={[styles.modalSlideArtwork, { width: artworkWidth, height: artworkHeight }]}
                  photosById={photosById}
                  slide={slide}
                />
                <View style={styles.modalCaption}>
                  <Text style={styles.modalSlideTitle}>
                    #{slide.rank} {slide.title}
                  </Text>
                  <Text style={styles.modalBodyText}>{slide.note}</Text>
                  <Text style={styles.modalMutedText}>{templateLabel(slide.template)}</Text>
                </View>
              </View>
            ))}
          </ScrollView>

          <View style={styles.modalDotRow}>
            {variation.slides.map((slide, index) => (
              <View
                key={slide.slideId}
                style={[styles.modalDot, index === activeSlideIndex && styles.modalDotActive]}
              />
            ))}
          </View>

          <View style={styles.modalSummary}>
            <View style={styles.flexText}>
              <Text style={styles.modalBodyText}>{variation.thesis}</Text>
              <Text style={styles.modalMutedText}>
                {activeSlideIndex + 1} of {variation.slideCount} · {activeSlide ? activeSlide.cropHint : 'vertical'} crop
              </Text>
            </View>
            <View style={styles.modalStatusPill}>
              <Text style={styles.modalStatusText}>{isSelected ? 'chosen' : percent(variation.confidence)}</Text>
            </View>
          </View>

          <View style={styles.modalActionBar}>
            <Pressable
              accessibilityRole="button"
              onPress={() => onSelectVariation(variation.variationId)}
              style={({ pressed }) => [styles.modalPrimaryButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.modalPrimaryButtonText}>{isSelected ? 'Keep edit' : 'Use this edit'}</Text>
            </Pressable>
            <View style={styles.modalSecondaryRow}>
              <Pressable
                accessibilityRole="button"
                onPress={() => onSaveToCameraRoll(variation.variationId)}
                style={({ pressed }) => [styles.modalSecondaryButton, pressed && styles.buttonPressed]}
              >
                <Text style={styles.modalSecondaryButtonText}>Export for Instagram</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => onSaveToCameraRoll(variation.variationId)}
                style={({ pressed }) => [styles.modalSecondaryButton, pressed && styles.buttonPressed]}
              >
                <Text style={styles.modalSecondaryButtonText}>Save photos</Text>
              </Pressable>
            </View>
            {canUseCreatorApi ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => onPrepareInstagramPost(variation.variationId)}
                style={({ pressed }) => [styles.modalTertiaryButton, pressed && styles.buttonPressed]}
              >
                <Text style={styles.modalTertiaryButtonText}>Publish with Creator API</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => setIsReplacing((currentValue) => !currentValue)}
              style={({ pressed }) => [styles.modalEditButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.modalEditButtonText}>{isReplacing ? 'Done replacing' : 'Replace a photo'}</Text>
            </Pressable>
            {isReplacing && activeSlide ? (
              <SlideReplacementPanel
                photosById={photosById}
                replacementCandidates={replacementCandidates}
                selectedSlotIndex={Math.min(replacementSlotIndex, activeSlide.photoIds.length - 1)}
                slide={activeSlide}
                onReplace={(photoIndex, replacementPhotoId) => {
                  onReplaceSlidePhoto(variation.variationId, activeSlide.slideId, photoIndex, replacementPhotoId);
                }}
                onSelectSlot={setReplacementSlotIndex}
              />
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={onStartNew}
              style={({ pressed }) => [styles.modalTertiaryButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.modalTertiaryButtonText}>Start another trip</Text>
            </Pressable>
            <Text style={styles.modalMutedText}>
              Instagram: {instagramStatusLabel(instagram)} · Export: {exportStatusLabel(exportStatus)}
            </Text>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function SlideReplacementPanel({
  photosById,
  replacementCandidates,
  selectedSlotIndex,
  slide,
  onReplace,
  onSelectSlot,
}: {
  photosById: Map<string, TripPhoto>;
  replacementCandidates: RankedPick[];
  selectedSlotIndex: number;
  slide: CarouselSlide;
  onReplace: (photoIndex: number, replacementPhotoId: string) => void;
  onSelectSlot: (photoIndex: number) => void;
}) {
  const currentPhotos = slide.photoIds
    .map((photoId, index) => ({
      index,
      photo: photosById.get(photoId),
    }))
    .filter((entry) => entry.photo) as Array<{ index: number; photo: TripPhoto }>;
  const currentPhotoIds = new Set(slide.photoIds);
  const candidates = replacementCandidates
    .filter((candidate) => !currentPhotoIds.has(candidate.photoId))
    .map((candidate) => ({
      pick: candidate,
      photo: photosById.get(candidate.photoId),
    }))
    .filter((entry) => entry.photo)
    .slice(0, 18) as Array<{ pick: RankedPick; photo: TripPhoto }>;

  return (
    <View style={styles.replacementPanel}>
      <View style={styles.replacementHeader}>
        <Text style={styles.modalSlideTitle}>Replace slide photo</Text>
        <Text style={styles.modalMutedText}>Slot {selectedSlotIndex + 1}</Text>
      </View>

      <View style={styles.replacementSlotRow}>
        {currentPhotos.map(({ index, photo }) => (
          <Pressable
            accessibilityRole="button"
            key={`${slide.slideId}-slot-${index}`}
            onPress={() => onSelectSlot(index)}
            style={[
              styles.replacementSlot,
              selectedSlotIndex === index && styles.replacementSlotSelected,
            ]}
          >
            <Image
              source={{ uri: photo.thumbnailUri ?? photo.localUri }}
              style={styles.replacementSlotImage}
            />
            <Text style={styles.replacementSlotText}>{index + 1}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        <View style={styles.replacementCandidateRow}>
          {candidates.map(({ pick, photo }) => (
            <Pressable
              accessibilityRole="button"
              key={pick.photoId}
              onPress={() => onReplace(selectedSlotIndex, pick.photoId)}
              style={styles.replacementCandidate}
            >
              <Image
                source={{ uri: photo.thumbnailUri ?? photo.localUri }}
                style={styles.replacementCandidateImage}
              />
              <Text style={styles.replacementCandidateText}>#{pick.rank}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function CarouselSlidePreview({
  photosById,
  slide,
}: {
  photosById: Map<string, TripPhoto>;
  slide: CarouselSlide;
}) {
  return (
    <View style={styles.slideRow}>
      <SlideArtwork
        photosById={photosById}
        slide={slide}
      />
      <View style={styles.slideText}>
        <Text style={styles.pickTitle}>
          #{slide.rank} {slide.title}
        </Text>
        <Text style={styles.bodyText}>{slide.note}</Text>
        <Text style={styles.mutedText}>{templateLabel(slide.template)}</Text>
      </View>
    </View>
  );
}

function SlideArtwork({
  frameStyle,
  photosById,
  slide,
}: {
  frameStyle?: StyleProp<ViewStyle>;
  photosById: Map<string, TripPhoto>;
  slide: CarouselSlide;
}) {
  const photos = slide.photoIds.map((photoId) => photosById.get(photoId)).filter(Boolean) as TripPhoto[];

  return (
    <View style={[styles.slidePreview, frameStyle]}>
      {slide.template === 'single' ? (
        <SlideImage photo={photos[0]} />
      ) : slide.template === 'vertical_triptych' ? (
        <View style={styles.triptychStack}>
          {photos.slice(0, 3).map((photo, index) => (
            <SlideImage
              compact
              key={`${slide.slideId}-${photo.photoId}-${index}`}
              photo={photo}
            />
          ))}
        </View>
      ) : slide.template === 'hero_with_details' ? (
        <View style={styles.heroDetailsLayout}>
          <View style={styles.heroDetailsMain}>
            <SlideImage photo={photos[0]} />
          </View>
          <View style={styles.heroDetailsSide}>
            {photos.slice(1, 3).map((photo, index) => (
              <SlideImage
                compact
                key={`${slide.slideId}-${photo.photoId}-${index}`}
                photo={photo}
              />
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.detailGridLayout}>
          {photos.slice(0, 4).map((photo, index) => (
            <View
              key={`${slide.slideId}-${photo.photoId}-${index}`}
              style={styles.detailGridCell}
            >
              <SlideImage photo={photo} />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function FeedPreviewTab({
  candidates,
  feedImport,
  instagram,
  onImportFeedSource,
  onUseInstagramFeed,
  photos,
  photosById,
}: {
  candidates: FeedPreviewCandidate[];
  feedImport?: FeedImportState;
  instagram?: InstagramConnectionState;
  onImportFeedSource: (mode: 'screenshot' | 'recent_posts') => void;
  onUseInstagramFeed: () => void;
  photos: TripPhoto[];
  photosById: Map<string, TripPhoto>;
}) {
  const bestCandidate = candidates[0];
  const bestPhoto = bestCandidate ? photosById.get(bestCandidate.photoId) : undefined;
  const gridCells = buildFeedGridCells(photos, bestPhoto, feedImport);

  return (
    <View style={styles.contentBlock}>
      <SectionHeader
        eyebrow="Feed Preview"
        title="Best next-feed photo"
        copy="The model picks a trip photo that fits the grid, then shows how it lands in the profile preview."
      />

      <FeedImportPanel
        feedImport={feedImport}
        instagram={instagram}
        onImportFeedSource={onImportFeedSource}
        onUseInstagramFeed={onUseInstagramFeed}
      />

      {bestCandidate && bestPhoto ? (
        <View style={styles.feedHero}>
          <View style={styles.feedGrid}>
            {gridCells.map((cell, index) => (
              <View
                key={`${cell.id}-${index}`}
                style={[styles.feedGridCell, cell.selected && styles.feedGridCellSelected]}
              >
                <Image
                  source={{ uri: cell.uri }}
                  style={styles.feedGridImage}
                />
              </View>
            ))}
          </View>
          <View style={styles.feedHeroCopy}>
            <Text style={styles.sectionTitle}>{bestPhoto.originalFilename}</Text>
            <Text style={styles.scoreText}>{percent(bestCandidate.fitScore)} feed fit</Text>
            <Text style={styles.bodyText}>{bestCandidate.reasons.join(' · ')}</Text>
            <Text style={styles.mutedText}>{bestCandidate.editHint}</Text>
          </View>
        </View>
      ) : (
        <EmptyState
          title="No feed candidate"
          copy="Run analysis with more photos to generate feed preview candidates."
        />
      )}

      <View style={styles.detailPanel}>
        <Text style={styles.panelTitle}>Alternates</Text>
        {candidates.slice(1, 7).map((candidate) => {
          const photo = photosById.get(candidate.photoId);

          if (!photo) {
            return null;
          }

          return (
            <View
              key={candidate.photoId}
              style={styles.feedRow}
            >
              <Image
                source={{ uri: photo.thumbnailUri ?? photo.localUri }}
                style={styles.feedImage}
              />
              <View style={styles.flexText}>
                <View style={styles.summaryRow}>
                  <Text style={styles.pickTitle}>{photo.originalFilename}</Text>
                  <Text style={styles.scoreText}>{percent(candidate.fitScore)}</Text>
                </View>
                <Text style={styles.mutedText}>{candidate.reasons.join(' · ')}</Text>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function FeedImportPanel({
  feedImport,
  instagram,
  onImportFeedSource,
  onUseInstagramFeed,
}: {
  feedImport?: FeedImportState;
  instagram?: InstagramConnectionState;
  onImportFeedSource: (mode: 'screenshot' | 'recent_posts') => void;
  onUseInstagramFeed: () => void;
}) {
  return (
    <View style={styles.feedImportPanel}>
      <View style={styles.summaryRow}>
        <View style={styles.flexText}>
          <Text style={styles.panelTitle}>Import current feed</Text>
          <Text style={styles.bodyText}>
            For personal accounts, use a grid screenshot or select recent posts. Creator/Business API import is optional.
          </Text>
        </View>
        <View style={styles.statusPill}>
          <Text style={styles.statusPillText}>{feedImportLabel(feedImport)}</Text>
        </View>
      </View>

      <View style={styles.integrationChoiceRow}>
        <Pressable
          accessibilityRole="button"
          onPress={onUseInstagramFeed}
          style={({ pressed }) => [styles.integrationChoice, pressed && styles.buttonPressed]}
        >
          <Text style={styles.panelTitle}>Creator API</Text>
          <Text style={styles.bodyText}>{instagramStatusLabel(instagram)}</Text>
        </Pressable>
        <View style={styles.integrationChoice}>
          <Text style={styles.panelTitle}>Manual feed</Text>
          <Text style={styles.bodyText}>Best path for everyday personal accounts.</Text>
        </View>
      </View>

      {feedImport?.assets.length ? (
        <View style={styles.importedFeedStrip}>
          {feedImport.assets.slice(0, 9).map((asset) => (
            <Image
              key={asset.id}
              source={{ uri: asset.uri }}
              style={feedImport.mode === 'screenshot' ? styles.feedScreenshotThumb : styles.importedPostThumb}
            />
          ))}
        </View>
      ) : (
        <Text style={styles.mutedText}>
          No feed source imported yet. The preview below uses a mock grid until you choose one.
        </Text>
      )}

      <View style={styles.actionRow}>
        <PrimaryButton
          label="Import grid screenshot"
          onPress={() => onImportFeedSource('screenshot')}
        />
        <SecondaryButton
          label="Select recent posts"
          onPress={() => onImportFeedSource('recent_posts')}
        />
        <SecondaryButton
          label="Creator API import"
          onPress={onUseInstagramFeed}
        />
      </View>
    </View>
  );
}

function buildFeedGridCells(photos: TripPhoto[], selectedPhoto?: TripPhoto, feedImport?: FeedImportState) {
  const fallback = photos.slice(0, 12).map((photo) => ({
    id: photo.photoId,
    uri: photo.thumbnailUri ?? photo.localUri ?? '',
    selected: false,
  }));

  if (!selectedPhoto) {
    return fallback;
  }

  const selectedCell = {
    id: selectedPhoto.photoId,
    uri: selectedPhoto.thumbnailUri ?? selectedPhoto.localUri ?? '',
    selected: true,
  };

  if ((feedImport?.mode === 'recent_posts' || feedImport?.mode === 'instagram') && feedImport.assets.length > 0) {
    return [
      selectedCell,
      ...feedImport.assets.slice(0, 11).map((asset) => ({
        id: asset.id,
        uri: asset.uri,
        selected: false,
      })),
    ];
  }

  return [
    selectedCell,
    ...fallback.filter((cell) => cell.id !== selectedPhoto.photoId).slice(0, 11),
  ];
}

function SlideImage({ compact, photo }: { compact?: boolean; photo?: TripPhoto }) {
  if (!photo) {
    return <View style={[styles.slideImage, compact && styles.slideImageCompact]} />;
  }

  return (
    <Image
      source={{ uri: photo.thumbnailUri ?? photo.localUri }}
      style={[styles.slideImage, compact && styles.slideImageCompact]}
    />
  );
}

function PhotoGrid({ photos }: { photos: TripPhoto[] }) {
  return (
    <View style={styles.photoGrid}>
      {photos.map((photo) => (
        <View
          key={photo.photoId}
          style={styles.photoTile}
        >
          <Image
            source={{ uri: photo.thumbnailUri ?? photo.localUri }}
            style={styles.photoTileImage}
          />
        </View>
      ))}
    </View>
  );
}

function PhotoStrip({
  photoIds,
  photosById,
}: {
  photoIds: string[];
  photosById: Map<string, TripPhoto>;
}) {
  return (
    <View style={styles.thumbnailStrip}>
      {photoIds.map((photoId, index) => {
        const photo = photosById.get(photoId);

        if (!photo) {
          return null;
        }

        return (
          <Image
            key={`${photoId}-${index}`}
            source={{ uri: photo.thumbnailUri ?? photo.localUri }}
            style={styles.stripImage}
          />
        );
      })}
    </View>
  );
}

function SectionHeader({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.kicker}>{eyebrow}</Text>
      <Text style={styles.headerTitle}>{title}</Text>
      <Text style={styles.bodyText}>{copy}</Text>
    </View>
  );
}

function PromiseItem({ label, detail }: { label: string; detail: string }) {
  return (
    <View style={styles.promiseItem}>
      <Text style={styles.panelTitle}>{label}</Text>
      <Text style={styles.bodyText}>{detail}</Text>
    </View>
  );
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.panelTitle}>{title}</Text>
      <Text style={styles.bodyText}>{copy}</Text>
    </View>
  );
}

function WorkflowStep({ label, detail }: { label: string; detail: string }) {
  return (
    <View style={styles.workflowStep}>
      <Text style={styles.panelTitle}>{label}</Text>
      <Text style={styles.bodyText}>{detail}</Text>
    </View>
  );
}

function TabButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.tabButton, active && styles.tabButtonActive]}
    >
      <Text style={[styles.tabButtonText, active && styles.tabButtonTextActive]}>{label}</Text>
    </Pressable>
  );
}

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
    >
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
    >
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function permissionCopy(permissionState: PermissionState) {
  if (permissionState === 'granted') {
    return 'Access is ready. Choose the full trip set when possible.';
  }

  if (permissionState === 'limited') {
    return 'Limited access is enough for a prototype. Add more selected photos if the trip is missing.';
  }

  if (permissionState === 'denied') {
    return 'Photo access was denied. You can still use the sample trip.';
  }

  return 'The picker asks for selected-photo access. Originals stay local in this fake-data build.';
}

function templateLabel(template: CarouselSlide['template']) {
  if (template === 'vertical_triptych') {
    return 'Vertical triptych template';
  }

  if (template === 'hero_with_details') {
    return 'Hero with details template';
  }

  if (template === 'detail_grid') {
    return 'Detail grid template';
  }

  return 'Single photo slide';
}

function feedImportLabel(feedImport?: FeedImportState) {
  if (!feedImport || feedImport.mode === 'none' || feedImport.assets.length === 0) {
    return 'mock grid';
  }

  if (feedImport.mode === 'screenshot') {
    return 'screenshot';
  }

  if (feedImport.mode === 'instagram') {
    return 'instagram';
  }

  return `${feedImport.assets.length} posts`;
}

function instagramStatusLabel(instagram?: InstagramConnectionState) {
  if (!instagram || instagram.status === 'not_connected') {
    return 'not connected';
  }

  if (instagram.status === 'setup_required') {
    return 'setup required';
  }

  if (instagram.status === 'error') {
    return instagram.errorMessage ?? 'connection error';
  }

  if (instagram.shareStatus === 'published') {
    return `${instagram.username ? `@${instagram.username}` : 'connected'} · published`;
  }

  if (instagram.shareStatus === 'requires_export') {
    return `${instagram.username ? `@${instagram.username}` : 'connected'} · export needed`;
  }

  if (instagram.shareStatus === 'render_required') {
    return `${instagram.username ? `@${instagram.username}` : 'connected'} · render needed`;
  }

  if (instagram.shareStatus === 'feed_imported') {
    return `${instagram.username ? `@${instagram.username}` : 'connected'} · feed imported`;
  }

  return instagram.username ? `@${instagram.username}` : 'connected';
}

function instagramConnectionDetail(instagram: InstagramConnectionState) {
  if (instagram.status === 'setup_required') {
    return 'Add Meta app credentials to the API only when testing Creator/Business API access.';
  }

  if (instagram.status === 'error') {
    return instagram.errorMessage ?? 'The API could not load Instagram status.';
  }

  if (instagram.status !== 'connected') {
    return 'No Instagram login is required for personal-account export, sharing, or manual feed preview.';
  }

  const accountType = instagram.accountType === 'professional' ? 'Professional' : 'Personal';
  const capability = instagram.publishCapability?.status;

  if (capability === 'available') {
    return `${accountType} account. Creator API publishing is available when rendered public slide URLs exist.`;
  }

  if (capability === 'requires_professional_account') {
    return `${accountType} account. Meta requires Creator/Business eligibility for API publishing; use export/share.`;
  }

  if (capability === 'requires_public_media') {
    return `${accountType} account. Carousel publishing needs rendered public media URLs first.`;
  }

  return `${accountType} account connected. Feed import is available through the API.`;
}

function exportStatusLabel(status?: ExportStatus) {
  if (status === 'saved_to_camera_roll') {
    return 'saved';
  }

  if (status === 'share_sheet_ready') {
    return 'share ready';
  }

  return 'draft';
}

function formatShortDate(value?: string) {
  if (!value) {
    return 'today';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'today';
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F6F8',
  },
  screenTopBar: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  topBarTitle: {
    color: '#1E2328',
    fontSize: 16,
    fontWeight: '900',
  },
  headerActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerSettingsButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
  },
  headerSettingsIcon: {
    color: '#1E2328',
    fontSize: 20,
    fontWeight: '900',
  },
  settingsModalBackdrop: {
    flex: 1,
    backgroundColor: '#F4F6F8',
  },
  settingsPage: {
    padding: 18,
    paddingBottom: 36,
    gap: 14,
  },
  settingsHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  settingsCard: {
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
    gap: 12,
  },
  settingsMetricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  settingsMetric: {
    width: '48%',
    borderWidth: 1,
    borderColor: '#EEF1F4',
    borderRadius: 8,
    backgroundColor: '#F8FAFC',
    padding: 10,
    gap: 4,
  },
  settingsMetricLabel: {
    color: '#66717E',
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  settingsMetricValue: {
    color: '#1E2328',
    fontSize: 14,
    fontWeight: '900',
  },
  modalCloseButtonLight: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#C9D1D9',
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
  },
  modalCloseButtonLightText: {
    color: '#1E2328',
    fontSize: 13,
    fontWeight: '900',
  },
  page: {
    padding: 18,
    paddingBottom: 36,
    gap: 18,
  },
  centerPage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
    backgroundColor: '#F4F6F8',
  },
  heroBand: {
    gap: 18,
  },
  heroText: {
    gap: 10,
  },
  kicker: {
    color: '#E4572E',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  heroTitle: {
    color: '#1E2328',
    fontSize: 34,
    fontWeight: '900',
    lineHeight: 39,
  },
  heroCopy: {
    color: '#4A5561',
    fontSize: 16,
    lineHeight: 23,
  },
  heroPreview: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  heroImage: {
    width: '31%',
    aspectRatio: 0.82,
    borderRadius: 8,
    backgroundColor: '#D6DCE3',
  },
  heroImageLarge: {
    width: '64%',
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  primaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#1E2328',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  secondaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#C9D1D9',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  secondaryButtonText: {
    color: '#1E2328',
    fontSize: 15,
    fontWeight: '800',
  },
  buttonPressed: {
    opacity: 0.72,
  },
  promiseGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  storageNotice: {
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
    gap: 7,
  },
  promiseItem: {
    width: '48%',
    minHeight: 118,
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
    gap: 7,
  },
  sectionHeader: {
    gap: 8,
  },
  headerTitle: {
    color: '#1E2328',
    fontSize: 24,
    fontWeight: '900',
    lineHeight: 30,
  },
  sectionTitle: {
    color: '#1E2328',
    fontSize: 20,
    fontWeight: '900',
  },
  panelTitle: {
    color: '#1E2328',
    fontSize: 16,
    fontWeight: '900',
  },
  bodyText: {
    color: '#4A5561',
    fontSize: 14,
    lineHeight: 20,
  },
  mutedText: {
    color: '#66717E',
    fontSize: 13,
    lineHeight: 18,
  },
  flexText: {
    flex: 1,
    gap: 4,
  },
  permissionPanel: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
  },
  statusPill: {
    flexShrink: 0,
    borderRadius: 999,
    backgroundColor: '#E4F7F3',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statusPillError: {
    backgroundColor: '#FFE9E3',
  },
  statusPillSelected: {
    backgroundColor: '#1E2328',
  },
  statusPillText: {
    color: '#176F64',
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  statusPillTextSelected: {
    color: '#FFFFFF',
  },
  contentBlock: {
    gap: 14,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  countBadge: {
    minWidth: 72,
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: '#F2AA4C',
    padding: 10,
  },
  countBadgeValue: {
    color: '#1E2328',
    fontSize: 20,
    fontWeight: '900',
  },
  countBadgeLabel: {
    color: '#1E2328',
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  photoTile: {
    width: '31.9%',
    aspectRatio: 0.78,
    overflow: 'hidden',
    borderRadius: 8,
    backgroundColor: '#D6DCE3',
  },
  photoTileImage: {
    width: '100%',
    height: '100%',
  },
  emptyState: {
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 18,
    gap: 8,
  },
  savedTripCard: {
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
    gap: 12,
  },
  savedTripMeta: {
    gap: 5,
  },
  analysisBox: {
    width: '100%',
    maxWidth: 420,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 22,
    gap: 12,
  },
  analysisTitle: {
    color: '#1E2328',
    fontSize: 24,
    fontWeight: '900',
    textAlign: 'center',
  },
  analysisStep: {
    color: '#E4572E',
    fontSize: 16,
    fontWeight: '900',
    textAlign: 'center',
  },
  progressTrack: {
    width: '100%',
    height: 10,
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: '#E6EBF0',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#17A398',
  },
  resultsShell: {
    flex: 1,
    backgroundColor: '#F4F6F8',
  },
  resultsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 12,
    paddingTop: 12,
    gap: 12,
  },
  newTripButton: {
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
  },
  newTripButtonText: {
    color: '#1E2328',
    fontWeight: '900',
  },
  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: 18,
    paddingBottom: 12,
    gap: 8,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  tabButtonActive: {
    borderColor: '#1E2328',
    backgroundColor: '#1E2328',
  },
  tabButtonText: {
    color: '#4A5561',
    fontSize: 13,
    fontWeight: '800',
  },
  tabButtonTextActive: {
    color: '#FFFFFF',
  },
  resultsContent: {
    paddingHorizontal: 18,
    paddingBottom: 36,
    gap: 14,
  },
  workflowNotice: {
    borderWidth: 1,
    borderColor: '#BFE5DF',
    borderRadius: 8,
    backgroundColor: '#E4F7F3',
    padding: 14,
    gap: 6,
  },
  optionCard: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 10,
    gap: 12,
  },
  optionCardSelected: {
    borderColor: '#E4572E',
    backgroundColor: '#FFF8F5',
  },
  optionCover: {
    width: 86,
    height: 112,
    borderRadius: 6,
    backgroundColor: '#D6DCE3',
  },
  optionBody: {
    flex: 1,
    gap: 7,
  },
  scoreText: {
    color: '#176F64',
    fontSize: 14,
    fontWeight: '900',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    borderRadius: 999,
    backgroundColor: '#E4F7F3',
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  chipText: {
    color: '#176F64',
    fontSize: 11,
    fontWeight: '800',
  },
  previewPrompt: {
    color: '#E4572E',
    fontSize: 13,
    fontWeight: '900',
  },
  detailPanel: {
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
    gap: 12,
  },
  exportPanel: {
    borderWidth: 1,
    borderColor: '#FFD2C4',
    borderRadius: 8,
    backgroundColor: '#FFF8F5',
    padding: 14,
    gap: 14,
  },
  exportSteps: {
    gap: 8,
  },
  workflowStep: {
    borderTopWidth: 1,
    borderTopColor: '#FFE1D7',
    paddingTop: 10,
    gap: 4,
  },
  slideRow: {
    flexDirection: 'row',
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: '#EEF1F4',
    paddingTop: 12,
  },
  slidePreview: {
    width: 96,
    aspectRatio: 0.8,
    overflow: 'hidden',
    borderRadius: 8,
    backgroundColor: '#D6DCE3',
  },
  slideImage: {
    width: '100%',
    height: '100%',
    backgroundColor: '#D6DCE3',
  },
  slideImageCompact: {
    flex: 1,
  },
  triptychStack: {
    flex: 1,
    gap: 2,
  },
  heroDetailsLayout: {
    flex: 1,
    flexDirection: 'row',
    gap: 2,
  },
  heroDetailsMain: {
    flex: 2,
  },
  heroDetailsSide: {
    flex: 1,
    gap: 2,
  },
  detailGridLayout: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
  },
  detailGridCell: {
    width: '49%',
    height: '49%',
  },
  carouselModalBackdrop: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#07090B',
  },
  carouselModalFrame: {
    flex: 1,
    backgroundColor: '#07090B',
  },
  carouselModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 10,
    paddingTop: 10,
  },
  modalKicker: {
    color: '#F2AA4C',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '900',
  },
  modalCloseButton: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#29313A',
    borderRadius: 999,
    paddingHorizontal: 14,
  },
  modalCloseText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
  },
  modalSlidePager: {
    flexGrow: 0,
  },
  modalSlidePage: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  modalSlideArtwork: {
    borderRadius: 4,
    backgroundColor: '#111820',
  },
  modalCaption: {
    width: '100%',
    gap: 5,
  },
  modalSlideTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '900',
  },
  modalBodyText: {
    color: '#E6EBF0',
    fontSize: 14,
    lineHeight: 20,
  },
  modalMutedText: {
    color: '#A8B1BA',
    fontSize: 12,
    lineHeight: 17,
  },
  modalDotRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
  },
  modalDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: '#3B4652',
  },
  modalDotActive: {
    width: 18,
    backgroundColor: '#FFFFFF',
  },
  modalSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: '#1C232B',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  modalStatusPill: {
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  modalStatusText: {
    color: '#07090B',
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  modalActionBar: {
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#1C232B',
    paddingHorizontal: 16,
    paddingBottom: 14,
    paddingTop: 12,
  },
  modalPrimaryButton: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
  },
  modalPrimaryButtonText: {
    color: '#07090B',
    fontSize: 14,
    fontWeight: '900',
  },
  modalSecondaryRow: {
    flexDirection: 'row',
    gap: 8,
  },
  modalSecondaryButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#3B4652',
    borderRadius: 8,
  },
  modalSecondaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
  },
  modalEditButton: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#29313A',
    borderRadius: 8,
  },
  modalEditButtonText: {
    color: '#F2AA4C',
    fontSize: 13,
    fontWeight: '900',
  },
  modalTertiaryButton: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalTertiaryButtonText: {
    color: '#A8B1BA',
    fontSize: 13,
    fontWeight: '800',
  },
  replacementPanel: {
    gap: 10,
    borderWidth: 1,
    borderColor: '#29313A',
    borderRadius: 8,
    padding: 10,
  },
  replacementHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  replacementSlotRow: {
    flexDirection: 'row',
    gap: 8,
  },
  replacementSlot: {
    width: 52,
    height: 64,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#29313A',
    borderRadius: 6,
    backgroundColor: '#111820',
  },
  replacementSlotSelected: {
    borderColor: '#F2AA4C',
  },
  replacementSlotImage: {
    width: '100%',
    height: '100%',
  },
  replacementSlotText: {
    position: 'absolute',
    bottom: 3,
    right: 5,
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  replacementCandidateRow: {
    flexDirection: 'row',
    gap: 8,
    paddingRight: 8,
  },
  replacementCandidate: {
    width: 56,
    gap: 4,
  },
  replacementCandidateImage: {
    width: 56,
    height: 68,
    borderRadius: 6,
    backgroundColor: '#111820',
  },
  replacementCandidateText: {
    color: '#A8B1BA',
    fontSize: 11,
    fontWeight: '800',
    textAlign: 'center',
  },
  slideText: {
    flex: 1,
    gap: 5,
  },
  pickTitle: {
    color: '#1E2328',
    fontSize: 15,
    fontWeight: '900',
  },
  thumbnailStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  stripImage: {
    width: 48,
    height: 58,
    borderRadius: 6,
    backgroundColor: '#D6DCE3',
  },
  feedHero: {
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
    gap: 14,
  },
  feedImportPanel: {
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 14,
    gap: 12,
  },
  integrationChoiceRow: {
    flexDirection: 'row',
    gap: 10,
  },
  integrationChoice: {
    flex: 1,
    minHeight: 92,
    borderWidth: 1,
    borderColor: '#DCE2E8',
    borderRadius: 8,
    backgroundColor: '#F8FAFC',
    padding: 12,
    gap: 6,
  },
  importedFeedStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  feedScreenshotThumb: {
    width: '100%',
    aspectRatio: 1.1,
    borderRadius: 6,
    backgroundColor: '#D6DCE3',
  },
  importedPostThumb: {
    width: '31.8%',
    aspectRatio: 1,
    borderRadius: 6,
    backgroundColor: '#D6DCE3',
  },
  feedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  feedGridCell: {
    width: '32%',
    aspectRatio: 1,
    overflow: 'hidden',
    borderRadius: 4,
    backgroundColor: '#D6DCE3',
  },
  feedGridCellSelected: {
    borderWidth: 3,
    borderColor: '#E4572E',
  },
  feedGridImage: {
    width: '100%',
    height: '100%',
  },
  feedHeroCopy: {
    gap: 7,
  },
  feedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: '#EEF1F4',
    paddingTop: 10,
  },
  feedImage: {
    width: 64,
    height: 76,
    borderRadius: 6,
    backgroundColor: '#D6DCE3',
  },
});
