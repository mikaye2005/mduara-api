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
  adminUserStatusSchema,
} from '../validation/admin.validation';
import { UnauthorizedError } from '../utils/errors';

function actor(req: Request): string {
  if (!req.user?.id || !req.user.isPlatformAdmin) throw new UnauthorizedError('Platform administrator authentication is required');
  return req.user.id;
}

export async function overview(req: Request,res:Response,next:NextFunction){try{actor(req);res.json({data:await adminService.overview()});}catch(e){next(e);}}
export async function revenue(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminRangeSchema.parse(req.query);res.json({data:await adminService.revenue(q.range)});}catch(e){next(e);}}
export async function listUsers(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminUserListSchema.parse(req.query);const r=await adminService.listUsers({page:q.page,perPage:q.per_page,status:q.status,q:q.q});res.json({data:r.users,meta:r.meta});}catch(e){next(e);}}
export async function moderateUser(req:Request,res:Response,next:NextFunction){try{const id=actor(req);const body=adminUserStatusSchema.parse(req.body);res.json({data:await adminService.moderateUser(id,req.params.userId,body,{ip:req.ip,userAgent:req.get('user-agent')??null})});}catch(e){next(e);}}
export async function listChamas(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminChamaListSchema.parse(req.query);const r=await adminService.listChamas({page:q.page,perPage:q.per_page,status:q.status,q:q.q});res.json({data:r.chamas,meta:r.meta});}catch(e){next(e);}}
export async function listPayments(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminPaymentListSchema.parse(req.query);const r=await adminService.listPayments({page:q.page,perPage:q.per_page,status:q.status,from:q.from,to:q.to,q:q.q});res.json({data:r.payments,meta:r.meta});}catch(e){next(e);}}
export async function listRefunds(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminCommitmentListSchema.parse(req.query);const r=await adminService.listRefunds({page:q.page,perPage:q.per_page,state:q.state,q:q.q});res.json({data:r.items,meta:r.meta});}catch(e){next(e);}}
export async function listDefaults(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminCommitmentListSchema.parse(req.query);const r=await adminService.listDefaults({page:q.page,perPage:q.per_page,state:q.state,q:q.q});res.json({data:r.items,meta:r.meta});}catch(e){next(e);}}
export async function listApplications(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminApplicationListSchema.parse(req.query);const r=await adminService.listApplications({page:q.page,perPage:q.per_page,status:q.status,q:q.q});res.json({data:r.applications,meta:r.meta});}catch(e){next(e);}}
export async function listTickets(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminTicketListSchema.parse(req.query);const r=await adminService.listTickets({page:q.page,perPage:q.per_page,status:q.status,category:q.category,q:q.q});res.json({data:r.tickets,meta:r.meta});}catch(e){next(e);}}
export async function suspiciousActivity(req:Request,res:Response,next:NextFunction){try{actor(req);res.json({data:await adminService.suspiciousActivity()});}catch(e){next(e);}}
export async function systemHealth(req:Request,res:Response,next:NextFunction){try{actor(req);res.json({data:await adminService.systemHealth()});}catch(e){next(e);}}
export async function auditLogs(req:Request,res:Response,next:NextFunction){try{actor(req);const q=adminAuditListSchema.parse(req.query);const r=await adminService.auditLogs({page:q.page,perPage:q.per_page,category:q.category,action:q.action,actorId:q.actor_id});res.json({data:r.logs,meta:r.meta});}catch(e){next(e);}}

export default {overview,revenue,listUsers,moderateUser,listChamas,listPayments,listRefunds,listDefaults,listApplications,listTickets,suspiciousActivity,systemHealth,auditLogs};
