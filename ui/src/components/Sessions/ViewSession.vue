<script setup lang="ts">
import { ArrowLeftIcon } from '@heroicons/vue/24/solid';
import { onMounted, onUnmounted, ref, watch } from 'vue';
import {
  SessionBase,
  deleteSession,
  getSession,
  patchSession,
  postCompleteSession,
} from '@/api/sessions.ts';
import { useRoute, useRouter } from 'vue-router';
import { showError, showSuccess } from '@/lib/notifications.ts';
import Menu from '@/components/Core/General/Menu.vue';
import { ChevronDownIcon, MicrophoneIcon } from '@heroicons/vue/20/solid';
import { MenuButton, MenuItem } from '@headlessui/vue';
import { ServerEvent } from '@/lib/serverEvents.ts';
import { useCurrentUserRole, useWebsocketChannel } from '@/lib/hooks.ts';
import CustomizableImage from '@/components/Images/CustomizableImage.vue';
import { useEventBus } from '@/lib/events.ts';
import RegeneratableTextEdit from '@/components/Core/Forms/RegeneratableTextEdit.vue';
import AudioUpload from '@/components/Core/Forms/AudioUpload.vue';
import ModalAlternate from '@/components/ModalAlternate.vue';
import AudioPlayback from '@/components/Core/General/AudioPlayback.vue';
import { CampaignRole } from '@/api/campaigns.ts';
import { debounce } from 'lodash';

const route = useRoute();
const router = useRouter();
const channel = useWebsocketChannel();
const eventBus = useEventBus();
const currentUserRole = useCurrentUserRole();

const session = ref<SessionBase>({} as SessionBase);
const loadingCompleteSession = ref(false);
const showUploadAudioModal = ref(false);

const sessionName = ref('');
const sessionImageUri = ref('');
const sessionSuggestedImagePrompt = ref('');

onMounted(async () => {
  await init();

  eventBus.$on('session-processing', (payload: { recap: string }) => {
    session.value.processing = true;
    session.value.recap = payload.recap;
  });

  eventBus.$on('session-summary-panel-updated', async (data: any) => {
    session.value.summary = data.summary;
    session.value.recap = data.recap;
    session.value.suggestions = data.suggestions;
    session.value.processing = data.processing;

    await router.push('summary');
  });

  channel.bind(ServerEvent.SessionUpdated, async function () {
    await init();
  });

  channel.bind(ServerEvent.SessionImageUpdated, async function (data: any) {
    session.value.imageUri = data.imageUri;
    session.value.suggestedImageUri = data.suggestedImageUri;
  });
});

onUnmounted(() => {
  eventBus.$off('session-processing');
  eventBus.$off('session-summary-panel-updated');

  channel.unbind(ServerEvent.SessionUpdated);
  channel.unbind(ServerEvent.SessionImageUpdated);
});

watch(
  sessionName,
  debounce(async () => {
    if (sessionName.value === session.value.name) {
      return;
    }

    await saveSession();
  }, 250),
);

watch(
  sessionImageUri,
  debounce(async () => {
    if (sessionImageUri.value === session.value.imageUri) {
      return;
    }

    await saveSession();
  }, 250),
);

async function init() {
  const response = await getSession(
    parseInt(route.params.sessionId.toString()),
  );

  session.value = response.data as SessionBase;
  sessionName.value = session.value.name || '';
  sessionImageUri.value = session.value.imageUri || '';
  sessionSuggestedImagePrompt.value = session.value.suggestedImagePrompt || '';
}

async function clickDeleteSession() {
  if (
    !confirm(
      `Are you sure you want to ${
        session.value.archived ? 'delete' : 'archive'
      } this session?`,
    )
  ) {
    return;
  }

  const deleteSessionResponse = await deleteSession(session.value.id);

  if (deleteSessionResponse.status === 200) {
    if (session.value.archived) {
      showSuccess({ message: 'Session deleted successfully!' });
      await router.push('/sessions');
    } else {
      showSuccess({ message: 'Session archived successfully!' });
      await init();
    }
  } else {
    showError({ message: 'Failed to delete session. Try again soon!' });
  }
}

async function clickUnarchiveSession() {
  const putSessionResponse = await patchSession({
    ...session.value,
    archived: false,
  });

  if (putSessionResponse.status === 200) {
    showSuccess({ message: 'Session unarchived successfully!' });
    await init();
  } else {
    showError({ message: 'Failed to unarchive session. Try again soon!' });
  }
}

async function saveSession() {
  const putSessionResponse = await patchSession({
    id: session.value.id,
    campaignId: session.value.campaignId,
    name: sessionName.value,
    imageUri: sessionImageUri.value,
    suggestedImagePrompt: sessionSuggestedImagePrompt.value,
  });

  if (putSessionResponse.status === 200) {
    showSuccess({ message: 'Changes saved!' });
  } else {
    showError({ message: 'Failed to save session' });
  }
}

async function completeSession() {
  loadingCompleteSession.value = true;
  const putSessionResponse = await postCompleteSession(session.value.id);

  if (putSessionResponse.status !== 200) {
    showError({ message: 'Failed to complete session' });
  } else {
    showSuccess({
      message:
        'Session completed! You and your players will be emailed a session recap.',
    });

    await init();
  }
  loadingCompleteSession.value = false;
}

function handleAudioUpload(payload: { audioUri: string; audioName: string }) {
  session.value = {
    ...session.value,
    ...payload,
  };
  showUploadAudioModal.value = false;
}
</script>

<template>
  <div v-if="session" class="my-8 md:min-h-[calc(100%-37rem)] pb-12">
    <div class="md:flex justify-between">
      <router-link
        :to="`/sessions`"
        class="bg-surface-2 flex rounded-md border-2 border-gray-600/50 p-3"
      >
        <ArrowLeftIcon class="mr-2 h-4 w-4 self-center" /> Back to list
      </router-link>

      <div v-if="session.processing">
        <div
          class="animate-pulse md:mt-0 mt-3 bg-amber-700 rounded-md px-3 text-white text-lg"
        >
          Processing...
        </div>
      </div>

      <div v-if="currentUserRole === CampaignRole.DM" class="md:flex">
        <button
          v-if="session.summary && !session.completed"
          class="h-12 rounded-md self-center bg-green-500 mt-3 md:mt-0 w-full md:w-auto md:mr-2 px-3 py-1 transition-all hover:scale-110"
          :disabled="loadingCompleteSession"
          @click="completeSession"
        >
          <span v-if="loadingCompleteSession">Loading...</span>
          <span v-else>Mark Complete</span>
        </button>

        <AudioPlayback
          v-if="session.audioUri"
          class="self-center mt-3 md:mt-0 mx-auto md:mx-0"
          :audio-uri="session.audioUri"
        />
        <div
          v-else
          class="h-12 self-center mt-3 md:mt-0 w-full md:w-auto rounded-md bg-fuchsia-500 flex px-3 py-1 transition-all hover:scale-110 cursor-pointer"
          @click="showUploadAudioModal = true"
        >
          <MicrophoneIcon class="w-5 h-5 mr-1 self-center" />
          <span class="self-center">Upload Audio</span>
        </div>

        <Menu
          class="mt-3 md:mt-0 self-center md:ml-0 w-[calc(100%-1.5rem)] ml-3 md:w-auto"
        >
          <MenuButton
            class="bg-surface-2 md:ml-2 self-center flex h-12 w-full justify-center rounded-md border-2 border-gray-600/50 px-3 py-1 text-white transition-all hover:scale-110"
          >
            <span class="text-md self-center"> More </span>
            <ChevronDownIcon
              class="-mr-1 ml-2 h-5 w-5 self-center text-violet-200 hover:text-violet-100"
              aria-hidden="true"
            />
          </MenuButton>
          <template #content>
            <div class="rounded-xl bg-neutral-800 p-4">
              <MenuItem v-if="!session.archived">
                <button
                  class="w-full rounded-xl border-2 border-red-500 px-3 py-1"
                  @click="clickDeleteSession"
                >
                  Archive
                </button>
              </MenuItem>
              <template v-else>
                <MenuItem>
                  <button
                    class="w-full rounded-xl border-2 border-green-500 px-3 py-1 mb-3"
                    @click="clickUnarchiveSession"
                  >
                    Unarchive
                  </button>
                </MenuItem>
                <MenuItem>
                  <button
                    class="w-full rounded-xl border-2 border-red-500 px-3 py-1"
                    @click="clickDeleteSession"
                  >
                    Delete
                  </button>
                </MenuItem>
              </template>
            </div>
          </template>
        </Menu>
      </div>
    </div>

    <div class="mt-6">
      <div class="md:flex mb-6">
        <div>
          <CustomizableImage
            :editable="currentUserRole === CampaignRole.DM"
            :image-uri="sessionImageUri || '/images/session_bg_square.png'"
            :prompt="sessionSuggestedImagePrompt"
            class="rounded-md w-[20rem]"
            @set-image="
              sessionImageUri = $event.imageUri;
              sessionSuggestedImagePrompt = $event.prompt;
            "
          />
        </div>

        <div class="md:ml-6 mt-3 md:mt-0 w-full">
          <RegeneratableTextEdit
            v-model="sessionName"
            :disabled="currentUserRole !== CampaignRole.DM"
            auto-height
            context="session"
            :background="{
              ...session,
              name: undefined,
            }"
            :disable-generation="!session.recap"
            input-class="$reset text-xl focus:ring-0 md:text-3xl 3xl:text-5xl border-none bg-transparent text-white w-full pl-0"
            outer-class="$reset"
            hide-label
            label="Name"
            type="text"
          />

          <div
            class="mt-2 px-2 w-fit rounded-md font-bold text-neutral-800 text-sm"
            :class="{
              'bg-blue-500':
                !session.completed && !session.processing && !session.archived,
              'bg-green-500': session.completed,
              'bg-amber-500': session.processing,
              'bg-red-500': session.archived,
            }"
          >
            <span
              v-if="
                !session.completed && !session.processing && !session.archived
              "
              >Active</span
            >
            <span v-if="session.processing">Processing</span>
            <span v-else-if="session.archived">Archived</span>
            <span v-else-if="session.completed">Completed</span>
          </div>

          <div class="mt-4 text-neutral-400">
            Summary
            <div class="text-sm text-neutral-500">
              {{ session.summary }}
            </div>
          </div>
        </div>
      </div>
      <div
        class="flex gap-8 text-neutral-400 rounded-md uppercase w-full bg-neutral-800 py-4 px-2"
      >
        <router-link
          to="planning"
          :class="{ 'text-white font-bold': route.path.endsWith('planning') }"
        >
          Planning
        </router-link>
        <router-link
          to="recap"
          :class="{ 'text-white font-bold': route.path.endsWith('recap') }"
        >
          Game Master Recap
        </router-link>
        <router-link
          to="summary"
          :class="{ 'text-white font-bold': route.path.endsWith('summary') }"
        >
          Summary
        </router-link>
      </div>
    </div>

    <div class="mt-8 overflow-y-auto pb-6">
      <router-view />
    </div>

    <ModalAlternate
      :show="showUploadAudioModal"
      @close="showUploadAudioModal = false"
    >
      <div class="md:w-[499px] p-6 bg-neutral-900 rounded-[20px]">
        <AudioUpload :session="session" @audio-uploaded="handleAudioUpload" />
      </div>
    </ModalAlternate>
  </div>
</template>

<style scoped>
audio {
  width: 100%;
  margin-bottom: 2rem;
}
audio::-webkit-media-controls-panel {
  background: linear-gradient(
    to right,
    rgb(135, 27, 164, 0.75),
    rgba(217, 117, 244, 0.75),
    rgba(64, 170, 241, 0.75)
  );
}
input[type='file'] {
  display: none;
}
</style>
