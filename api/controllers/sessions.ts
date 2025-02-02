import {
  Body,
  Delete,
  Get,
  Inject,
  OperationId,
  Patch,
  Post,
  Query,
  Route,
  Security,
  Tags,
} from 'tsoa';
import { prisma } from '../lib/providers/prisma';
import { AppError, HttpCode } from '../lib/errors/AppError';
import { Session } from '@prisma/client';
import { AppEvent, track, TrackingInfo } from '../lib/tracking';
import { CampaignRole } from './campaigns';
import { completeSessionQueue } from '../worker';
import { sendTransactionalEmail } from '../lib/transactionalEmail';
import { urlPrefix } from '../lib/utils';
import { parentLogger } from '../lib/logger';
const logger = parentLogger.getSubLogger();

interface GetSessionsResponse {
  data: Session[];
  offset?: number;
  limit?: number;
}

interface PostSessionRequest {
  campaignId: number;
  name: string;
}

interface PatchSessionRequest {
  name?: string;
  imageUri?: string;
  planning?: string;
  recap?: string;
  summary?: string;
  transcript?: string;
  suggestions?: string;
}

interface PostCompleteSessionRequest {
  recap: string;
}

interface PostSessionAudioRequest {
  audioName: string;
  audioUri: string;
}

interface PostSessionAudioResponse {
  audioName: string;
  audioUri: string;
}

export enum SessionStatus {
  UPCOMING = 1,
  COMPLETED = 2,
}

@Route('sessions')
@Tags('Sessions')
export default class SessionController {
  @Security('jwt')
  @OperationId('getSessions')
  @Get('/')
  public async getSessions(
    @Inject() userId: number,
    @Inject() trackingInfo: TrackingInfo,
    @Query() campaignId: number,
    @Query() offset?: number,
    @Query() limit?: number,
    @Query() archived = false,
  ): Promise<GetSessionsResponse> {
    const sessions = await prisma.session.findMany({
      where: {
        userId,
        campaignId,
        archived,
      },
      skip: offset,
      take: limit,
      orderBy: {
        createdAt: 'desc',
      },
    });

    track(AppEvent.GetSessions, userId, trackingInfo);

    return {
      data: sessions,
      offset: offset,
      limit: limit,
    };
  }

  @Security('jwt')
  @OperationId('getSession')
  @Get('/:sessionId')
  public async getSession(
    @Inject() userId: number,
    @Inject() trackingInfo: TrackingInfo,
    @Route() sessionId = 0,
  ): Promise<Session> {
    const session = await prisma.session.findUnique({
      where: {
        id: sessionId,
      },
    });

    if (!session) {
      throw new AppError({
        description: 'Session not found.',
        httpCode: HttpCode.NOT_FOUND,
      });
    }

    if (session.userId !== null && session.userId !== userId) {
      throw new AppError({
        description: 'You do not have access to this session.',
        httpCode: HttpCode.FORBIDDEN,
      });
    }

    track(AppEvent.GetSession, userId, trackingInfo);

    return session;
  }

  @Security('jwt')
  @OperationId('createSession')
  @Post('/')
  public async postSession(
    @Inject() userId: number,
    @Inject() trackingInfo: TrackingInfo,
    @Body() request: PostSessionRequest,
  ): Promise<Session> {
    const session = await prisma.session.create({
      data: {
        userId,
        ...request,
      },
    });

    track(AppEvent.CreateSession, userId, trackingInfo);

    return session;
  }

  @Security('jwt')
  @OperationId('updateSession')
  @Patch('/:sessionId')
  public async patchSession(
    @Inject() userId: number,
    @Inject() trackingInfo: TrackingInfo,
    @Route() sessionId: number,
    @Body() request: PatchSessionRequest,
  ): Promise<Session> {
    await this.getSession(userId, trackingInfo, sessionId);

    const session = await prisma.session.update({
      where: {
        id: sessionId,
      },
      data: {
        userId,
        ...request,
      },
    });

    track(AppEvent.UpdateSession, userId, trackingInfo);

    return session;
  }

  @Security('jwt')
  @OperationId('deleteSession')
  @Delete('/:sessionId')
  public async deleteSession(
    @Inject() userId: number,
    @Inject() trackingInfo: TrackingInfo,
    @Route() sessionId: number,
  ): Promise<boolean> {
    const session = await this.getSession(userId, trackingInfo, sessionId);

    if (!session.archived) {
      await prisma.session.update({
        where: {
          id: sessionId,
        },
        data: {
          archived: true,
        },
      });
      track(AppEvent.ArchiveSession, userId, trackingInfo);
    } else {
      await prisma.session.delete({
        where: {
          id: sessionId,
        },
      });
      track(AppEvent.DeleteSession, userId, trackingInfo);
    }

    return true;
  }

  @Security('jwt')
  @OperationId('generateSummary')
  @Post('/:sessionId/generate-summary')
  public async postGenerateSummary(
    @Inject() userId: number,
    @Inject() trackingInfo: TrackingInfo,
    @Route() sessionId: number,
    @Body() request: PostCompleteSessionRequest,
  ): Promise<boolean> {
    const session = await this.getSession(userId, trackingInfo, sessionId);
    const campaignMember = await prisma.campaignMember.findUnique({
      where: {
        userId_campaignId: {
          userId,
          campaignId: session.campaignId,
        },
      },
    });

    if (!campaignMember || campaignMember.role !== CampaignRole.DM) {
      throw new AppError({
        description: 'You do not have permission to complete this session.',
        httpCode: HttpCode.FORBIDDEN,
      });
    }

    await prisma.session.update({
      where: {
        id: sessionId,
      },
      data: {
        recap: request.recap,
      },
    });

    await completeSessionQueue.add({ userId, sessionId: sessionId });

    track(AppEvent.CompleteSession, userId, trackingInfo);

    return true;
  }

  @Security('jwt')
  @OperationId('completeSession')
  @Post('/:sessionId/complete')
  public async postCompleteSession(
    @Inject() userId: number,
    @Inject() trackingInfo: TrackingInfo,
    @Route() sessionId: number,
  ) {
    const session = await prisma.session.findUnique({
      where: {
        id: sessionId,
      },
    });

    if (!session) {
      logger.warn('Session not found', sessionId);

      throw new AppError({
        description: 'Session not found.',
        httpCode: HttpCode.BAD_REQUEST,
      });
    }

    const campaign = await prisma.campaign.findUnique({
      where: {
        id: session?.campaignId,
      },
      include: {
        members: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!campaign) {
      logger.warn('Campaign not found', sessionId);

      throw new AppError({
        description: 'Campaign not found.',
        httpCode: HttpCode.BAD_REQUEST,
      });
    }

    for (const member of campaign.members) {
      const email = member.user?.email || member.email;
      await sendTransactionalEmail(
        'post-session',
        `🎲 MythWeaver Session Recap: ${campaign.name} 🐉`,
        email || '',
        [
          {
            name: 'CHARACTER_NAME',
            content: email || '',
          },
          {
            name: 'CAMPAIGN_NAME',
            content: campaign.name,
          },
          {
            name: 'SUMMARY',
            content: session.summary || '',
          },
          {
            name: 'SUGGESTIONS',
            content: session.suggestions || '',
          },
          {
            name: 'SESSION_URL',
            content: `${urlPrefix}/sessions/${session?.id}/edit`,
          },
          {
            name: 'SESSION_IMAGE_URI',
            content: session.imageUri || '',
          },
        ],
      );
    }

    await prisma.session.update({
      where: {
        id: sessionId,
      },
      data: {
        completed: true,
      },
    });
  }

  @Security('jwt')
  @OperationId('postSessionAudio')
  @Post('/:sessionId/audio')
  public async postSessionAudio(
    @Inject() userId: number,
    @Inject() trackingInfo: TrackingInfo,
    @Route() sessionId: number,
    @Body() request: PostSessionAudioRequest,
  ): Promise<PostSessionAudioResponse> {
    const session = await this.getSession(userId, trackingInfo, sessionId);
    const campaignMember = await prisma.campaignMember.findUnique({
      where: {
        userId_campaignId: {
          userId,
          campaignId: session.campaignId,
        },
      },
    });

    if (!campaignMember || campaignMember.role !== CampaignRole.DM) {
      throw new AppError({
        description: 'You do not have permission to add audio to this session.',
        httpCode: HttpCode.FORBIDDEN,
      });
    }

    await prisma.session.update({
      where: {
        id: sessionId,
      },
      data: {
        audioName: request.audioName,
        audioUri: request.audioUri,
      },
    });

    track(AppEvent.SessionAudioUploaded, userId, trackingInfo);

    return {
      audioName: request.audioName,
      audioUri: request.audioUri,
    };
  }
}
