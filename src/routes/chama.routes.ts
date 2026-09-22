import { Router } from 'express';
import chamaController from '../controllers/chama.controller';
import goalController from '../controllers/goal.controller';
import pollController from '../controllers/poll.controller';
import reportController from '../controllers/report.controller';
import meetingController from '../controllers/meeting.controller';
import { authenticate, optionalAuthenticate } from '../middlewares/auth.middleware';
import { requireChamaMembership, requireChamaRoles } from '../middlewares/authorization.middleware';
import { requireDetailedPdfExportIfRequested } from '../middlewares/subscription.middleware';

const router = Router();
const byRouteId = { chamaIdParam: 'id' } as const;

// Constitution templates are authenticated creation/setup metadata, not Chama-scoped secrets.
router.get('/constitution/templates', authenticate, chamaController.listConstitutionTemplates);

// Public marketplace endpoints intentionally precede /:id routes so "public"
// can never be interpreted as a Chama UUID.
// Compatibility aliases preserve the original BE-12 tracker without replacing
// the newer canonical /public and /goals/matches contracts.
router.get('/', chamaController.listPublicChamas);
router.post('/match', optionalAuthenticate, goalController.matchGoalChamas);
router.get('/public', chamaController.listPublicChamas);
router.get('/public/:id', chamaController.getPublicChamaDetail);

// Chama creation is atomic: the authenticated founder becomes the initial active chairperson.
router.post('/', authenticate, chamaController.createChama);

// Join/apply always authenticates server-side. Visibility, Constitution and invite
// rules are resolved again inside the PostgreSQL transaction.
router.post('/:id/apply', authenticate, chamaController.applyToChama);

router.get(
  '/:id/reports/financial-statement',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'TREASURER', 'SECRETARY'], byRouteId),
  requireDetailedPdfExportIfRequested('id'),
  reportController.getChamaFinancialStatement,
);

router.post(
  '/:id/polls',
  authenticate,
  requireChamaRoles(['CHAIRPERSON'], byRouteId),
  pollController.createPoll,
);

router.get(
  '/:id/polls',
  authenticate,
  requireChamaMembership(byRouteId),
  pollController.listChamaPolls,
);

router.get(
  '/:id/constitution',
  authenticate,
  requireChamaMembership(byRouteId),
  chamaController.getChamaConstitution,
);

router.post(
  '/:id/rules',
  authenticate,
  requireChamaRoles(['CHAIRPERSON'], byRouteId),
  chamaController.configureChamaRules,
);

router.post(
  '/:id/rules/amend',
  authenticate,
  requireChamaRoles(['CHAIRPERSON'], byRouteId),
  chamaController.amendChamaRules,
);


router.post(
  '/:id/meetings',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'SECRETARY'], byRouteId),
  meetingController.createMeeting,
);

router.get(
  '/:id/meetings',
  authenticate,
  requireChamaMembership(byRouteId),
  meetingController.listMeetings,
);

router.get(
  '/:id/attendance',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'SECRETARY'], byRouteId),
  meetingController.attendanceHistory,
);

router.get(
  '/:id',
  authenticate,
  requireChamaMembership(byRouteId),
  chamaController.getChama,
);

router.patch(
  '/:id',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'SECRETARY'], byRouteId),
  chamaController.updateChama,
);

router.post(
  '/:id/invite',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'SECRETARY'], byRouteId),
  chamaController.inviteToChama,
);

// BE-14 canonical plural alias for shareable invitation links/codes.
router.post(
  '/:id/invites',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'SECRETARY'], byRouteId),
  chamaController.inviteToChama,
);

router.get(
  '/:id/invitations',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'SECRETARY'], byRouteId),
  chamaController.listChamaInvitations,
);

router.delete(
  '/:id/invitations/:invitationId',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'SECRETARY'], byRouteId),
  chamaController.cancelChamaInvitation,
);

router.post(
  '/:id/invitations/:invitationId/resend',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'SECRETARY'], byRouteId),
  chamaController.resendChamaInvitation,
);

router.post(
  '/:id/invitations/:invitationId/reject',
  authenticate,
  chamaController.rejectChamaInvitation,
);

router.get(
  '/:id/applications',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'SECRETARY'], byRouteId),
  chamaController.listChamaApplications,
);

router.patch(
  '/:id/applications/:applicationId',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'SECRETARY'], byRouteId),
  chamaController.reviewChamaApplication,
);

router.get(
  '/:id/members',
  authenticate,
  requireChamaMembership(byRouteId),
  chamaController.listChamaMembers,
);

router.patch(
  '/:id/members/:userId',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'SECRETARY'], byRouteId),
  chamaController.updateChamaMember,
);

export default router;
