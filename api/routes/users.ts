import express, { Request, Response } from 'express';
import { useAuthenticateRequest } from '../lib/authMiddleware';
import { z } from 'zod';
import { useValidateRequest } from '../lib/validationMiddleware';
import UserController from '../controllers/users';
import mailchimpClient from '../lib/mailchimpMarketing';
import { lists, Status } from '@mailchimp/mailchimp_marketing';
import EmailType = lists.EmailType;
import { format } from 'date-fns';
import { parentLogger } from '../lib/logger';
import { useInjectLoggingInfo } from '../lib/loggingMiddleware';
const logger = parentLogger.getSubLogger();

const router = express.Router();

router.get('/me', [
  useAuthenticateRequest(),
  useInjectLoggingInfo(),
  async (req: Request, res: Response) => {
    const controller = new UserController();

    const response = await controller.getUser(
      res.locals.auth.userId,
      res.locals.trackingInfo,
    );
    return res.status(200).send(response);
  },
]);

const patchUsersSchema = z.object({
  name: z.string().optional(),
  imageUri: z.string().optional(),
  tags: z.array(z.string()).optional(),
  data: z.array(z.object({ key: z.string(), value: z.any() })).optional(),
  confirmEarlyAccessStart: z.boolean().optional(),
});

router.patch('/me', [
  useAuthenticateRequest(),
  useInjectLoggingInfo(),
  useValidateRequest(patchUsersSchema),
  async (req: Request, res: Response) => {
    const controller = new UserController();

    const response = await controller.patchUser(
      res.locals.auth.userId,
      res.locals.trackingInfo,
      req.body,
    );
    return res.status(200).send(response);
  },
]);

const postPrereleaseSchema = z.object({
  email: z.string(),
  language: z.string(),
});

router.post('/prerelease', [
  useValidateRequest(postPrereleaseSchema),
  async (req: Request, res: Response) => {
    const payload = req.body as z.infer<typeof postPrereleaseSchema>;

    const newMember = {
      email_address: payload.email,
      email_type: 'html' as EmailType,
      status: 'subscribed' as Status,
      ip_opt: res.locals.trackingInfo.ip,
      ip_signup: res.locals.trackingInfo.ip,
      language: payload.language,
      timestamp_signup: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      timestamp_opt: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
    };

    const response = (await mailchimpClient.lists.batchListMembers(
      process.env.MAILCHIMP_AUDIENCE_ID as string,
      {
        members: [newMember],
      },
    )) as any;

    if (response?.errors?.length > 0) {
      logger.warn('Received errors from Mailchimp', response.errors);
    }

    return res.status(200).send();
  },
]);

export default router;
