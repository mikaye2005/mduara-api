import type { NextFunction, Request, Response } from 'express';
import { adminService } from '../services/admin.service';
import {
  adminApplicationListSchema,
  adminAuditListSchema,
  adminChamaListSchema,
  adminCommitmentListSchema,
  adminPaymentListSchema,
  adminRangeSchema,
  adminTicketListSchema,
  adminUserListSchema,
  adminProvisionUserSchema,
  adminUserStatusSchema,
  adminBroadcastSchema,
  adminIdParamSchema,
  adminLoanListSchema,
  adminMembershipSchema,
  adminNotificationListSchema,
  adminRoleChangeSchema,
  adminSearchSchema,
  adminTicketCommentSchema,
  adminTicketUpdateSchema,
} from '../validation/admin.validation';
import { supportService } from '../services/support.service';
import { UnauthorizedError } from '../utils/errors';

function actor(req: Request): string {
  if (!req.user?.id || !req.user.isPlatformAdmin) throw new UnauthorizedError('Platform administrator authentication is required');
  return req.user.id;
}

export async function overview(req: Request,res:Response,next:NextFunction){try{actor(req);res.json({data:await adminService.overview()});}catch(e){next(e);}}
export async function revenue(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminRangeSchema.parse(req.query);res.json({data:await adminService.revenue(q.range)});}catch(e){next(e);}}
export async function listUsers(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminUserListSchema.parse(req.query);const r=await adminService.listUsers({page:q.page,perPage:q.per_page,status:q.status,q:q.q});res.json({data:r.users,meta:r.meta});}catch(e){next(e);}}
export async function provisionUser(req:Request,res:Response,next:NextFunction){try{const id=actor(req);const body=adminProvisionUserSchema.parse(req.body) as {fullName:string;phone:string;email:string;temporaryPassword:string};res.status(201).json({data:await adminService.provisionUser(id,body,{ip:req.ip,userAgent:req.get('user-agent')??null})});}catch(e){next(e);}}
export async function search(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminSearchSchema.parse(req.query);res.json({data:await adminService.search(q.q,q.limit)});}catch(e){next(e);}}
export async function getUser(req:Request,res:Response,next:NextFunction){try{actor(req);res.json({data:await adminService.getUser(adminIdParamSchema.parse(req.params.userId))});}catch(e){next(e);}}
export async function moderateUser(req:Request,res:Response,next:NextFunction){try{const id=actor(req);const body=adminUserStatusSchema.parse(req.body) as {action:'suspend'|'reactivate'|'delete';reason:string};res.json({data:await adminService.moderateUser(id,req.params.userId,body,{ip:req.ip,userAgent:req.get('user-agent')??null})});}catch(e){next(e);}}
export async function listChamas(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminChamaListSchema.parse(req.query);const r=await adminService.listChamas({page:q.page,perPage:q.per_page,status:q.status,q:q.q});res.json({data:r.chamas,meta:r.meta});}catch(e){next(e);}}
export async function getChama(req:Request,res:Response,next:NextFunction){try{actor(req);res.json({data:await adminService.getChama(adminIdParamSchema.parse(req.params.chamaId))});}catch(e){next(e);}}
export async function addMembership(req:Request,res:Response,next:NextFunction){try{const id=actor(req);const body=adminMembershipSchema.parse(req.body) as {userId:string;role:'member'|'treasurer'|'secretary'|'chairperson';membershipStatus:'active'|'pending';reason:string};res.status(201).json({data:await adminService.addMembership(id,adminIdParamSchema.parse(req.params.chamaId),body,{ip:req.ip,userAgent:req.get('user-agent')??null})});}catch(e){next(e);}}
export async function changeRole(req:Request,res:Response,next:NextFunction){try{const id=actor(req);const body=adminRoleChangeSchema.parse(req.body) as {role:'member'|'treasurer'|'secretary'|'chairperson';reason:string};res.json({data:await adminService.changeRole(id,adminIdParamSchema.parse(req.params.chamaId),adminIdParamSchema.parse(req.params.userId),body,{ip:req.ip,userAgent:req.get('user-agent')??null})});}catch(e){next(e);}}
export async function listPayments(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminPaymentListSchema.parse(req.query);const r=await adminService.listPayments({page:q.page,perPage:q.per_page,status:q.status,from:q.from,to:q.to,q:q.q});res.json({data:r.payments,meta:r.meta});}catch(e){next(e);}}
export async function getPayment(req:Request,res:Response,next:NextFunction){try{actor(req);res.json({data:await adminService.getPayment(adminIdParamSchema.parse(req.params.paymentId))});}catch(e){next(e);}}
export async function listRefunds(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminCommitmentListSchema.parse(req.query);const r=await adminService.listRefunds({page:q.page,perPage:q.per_page,state:q.state,q:q.q});res.json({data:r.items,meta:r.meta});}catch(e){next(e);}}
export async function listDefaults(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminCommitmentListSchema.parse(req.query);const r=await adminService.listDefaults({page:q.page,perPage:q.per_page,state:q.state,q:q.q});res.json({data:r.items,meta:r.meta});}catch(e){next(e);}}
export async function listApplications(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminApplicationListSchema.parse(req.query);const r=await adminService.listApplications({page:q.page,perPage:q.per_page,status:q.status,q:q.q});res.json({data:r.applications,meta:r.meta});}catch(e){next(e);}}
export async function listTickets(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminTicketListSchema.parse(req.query);const r=await adminService.listTickets({page:q.page,perPage:q.per_page,status:q.status,category:q.category,q:q.q});res.json({data:r.tickets,meta:r.meta});}catch(e){next(e);}}
export async function getTicket(req:Request,res:Response,next:NextFunction){try{const id=actor(req);const ticket=await supportService.getTicket(id,req.params.ticketId);const comments=await adminService.listTicketComments(req.params.ticketId);res.json({data:{...ticket,comments}});}catch(e){next(e);}}
export async function updateTicket(req:Request,res:Response,next:NextFunction){try{const id=actor(req);const body=adminTicketUpdateSchema.parse(req.body);res.json({data:await supportService.updateTicket(id,req.params.ticketId,body)});}catch(e){next(e);}}
export async function addTicketComment(req:Request,res:Response,next:NextFunction){try{const id=actor(req);const body=adminTicketCommentSchema.parse(req.body) as {body:string;internal:boolean};res.status(201).json({data:await adminService.addTicketComment(id,req.params.ticketId,body,{ip:req.ip,userAgent:req.get('user-agent')??null})});}catch(e){next(e);}}
export async function listLoans(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminLoanListSchema.parse(req.query);const r=await adminService.listLoans({page:q.page,perPage:q.per_page,status:q.status,q:q.q});res.json({data:r.loans,meta:r.meta});}catch(e){next(e);}}
export async function listNotifications(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminNotificationListSchema.parse(req.query);const r=await adminService.listNotifications({page:q.page,perPage:q.per_page,status:q.status,channel:q.channel});res.json({data:r.notifications,meta:r.meta});}catch(e){next(e);}}
export async function broadcast(req:Request,res:Response,next:NextFunction){try{const id=actor(req);const body=adminBroadcastSchema.parse(req.body) as {audience:'all_active_users'|'platform_admins'|'chama';chamaId?:string;channels:('in_app'|'sms'|'email'|'push')[];title:string;body:string;reason:string};res.status(202).json({data:await adminService.broadcast(id,body,{ip:req.ip,userAgent:req.get('user-agent')??null})});}catch(e){next(e);}}
export async function listAdministrators(req:Request,res:Response,next:NextFunction){try{actor(req);res.json({data:await adminService.listAdministrators()});}catch(e){next(e);}}
export async function suspiciousActivity(req:Request,res:Response,next:NextFunction){try{actor(req);res.json({data:await adminService.suspiciousActivity()});}catch(e){next(e);}}
export async function systemHealth(req:Request,res:Response,next:NextFunction){try{actor(req);res.json({data:await adminService.systemHealth()});}catch(e){next(e);}}
export async function auditLogs(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminAuditListSchema.parse(req.query);const r=await adminService.auditLogs({page:q.page,perPage:q.per_page,category:q.category,action:q.action,actorId:q.actor_id});res.json({data:r.logs,meta:r.meta});}catch(e){next(e);}}

export default {overview,revenue,search,listUsers,provisionUser,getUser,moderateUser,listChamas,getChama,addMembership,changeRole,listPayments,getPayment,listRefunds,listDefaults,listApplications,listLoans,listTickets,getTicket,updateTicket,addTicketComment,listNotifications,broadcast,listAdministrators,suspiciousActivity,systemHealth,auditLogs};
