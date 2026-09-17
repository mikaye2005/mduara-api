import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { UploadService } from '../../services/upload.service';
import { SupportService } from '../../services/support.service';
import { updateMyProfileSchema } from '../../validation/user.validation';
import { updateChamaSchema } from '../../validation/chama.validation';
import { createUploadSchema } from '../../validation/upload.validation';
import type { ObjectHead, ObjectStorageAdapter, SignedObjectUrl, SignedUploadForm } from '../../services/object-storage.service';


const databaseUrl = process.env.TEST_DATABASE_URL;


class FakeStorage implements ObjectStorageAdapter {
  readonly objects = new Map<string, ObjectHead>();
  readonly deleted: string[] = [];
  createUploadForm(input: { objectKey: string; uploadId: string; mimeType: string; sizeBytes: number }): SignedUploadForm {
    return { url: 'https://storage.test/form', method: 'POST', fields: { key: input.objectKey, 'Content-Type': input.mimeType, 'x-amz-meta-upload-id': input.uploadId }, expiresAt: new Date(Date.now() + 900_000).toISOString() };
  }
  createDownloadUrl(objectKey: string, fileName: string): SignedObjectUrl {
    return { url: `https://storage.test/get/${encodeURIComponent(objectKey)}?name=${encodeURIComponent(fileName)}`, expiresAt: new Date(Date.now() + 300_000).toISOString() };
  }
  async headObject(objectKey: string) { return this.objects.get(objectKey) ?? null; }
  async deleteObject(objectKey: string) { this.deleted.push(objectKey); this.objects.delete(objectKey); }
}


test('BE-22 private media upload, scan and authorization lifecycle', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `be22_${randomUUID().replace(/-/g, '')}`;
  const adminDb = new Pool({ connectionString: databaseUrl });
  const db = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema},public` });
  const storage = new FakeStorage();
  const uploads = new UploadService(db, storage);
  const support = new SupportService(db);


  t.after(async () => {
    await db.end();
    await adminDb.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminDb.end();
  });


  await migrate({
    databaseUrl: databaseUrl!, dir: 'migrations', direction: 'up', schema,
    createSchema: true, migrationsSchema: schema, migrationsTable: 'pgmigrations',
    ignorePattern: '.*\\.sql', singleTransaction: true, log: () => {},
  });


  async function user(name: string, suffix: string, admin = false) {
    return (await db.query<{ id: string }>(
      `INSERT INTO users (email,pin_hash,full_name,phone,status,is_platform_admin)
       VALUES ($1,'hash',$2,$3,'active',$4) RETURNING id`,
      [`${randomUUID()}@example.test`, name, `+254733${suffix.padStart(6, '0')}`, admin],
    )).rows[0].id;
  }
  async function member(chamaId: string, userId: string, role: 'chairperson' | 'secretary' | 'member' = 'member') {
    return (await db.query<{ id: string }>(
      `INSERT INTO chama_members (chama_id,user_id,role,membership_status)
       VALUES ($1,$2,$3,'active') RETURNING id`, [chamaId, userId, role],
    )).rows[0].id;
  }
  async function putObjectFor(uploadId: string, size: number, mime: string) {
    const row = (await db.query<{ object_key: string }>(`SELECT object_key FROM media_uploads WHERE id = $1`, [uploadId])).rows[0];
    storage.objects.set(row.object_key, { contentLength: size, contentType: mime, etag: randomUUID(), uploadId });
    return row.object_key;
  }
  async function scanClean(uploadId: string, detectedMimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf' | 'text/plain') {
    const claims = await uploads.claimScans(20);
    const claim = claims.find((item) => item.id === uploadId);
    assert.ok(claim, `expected scanner claim for ${uploadId}`);
    return uploads.recordScanResult(uploadId, {
      claimToken: claim.claimToken!, verdict: 'clean', provider: 'test-scanner',
      reference: `scan-${uploadId}`, detectedMimeType, sha256: 'a'.repeat(64),
    });
  }


  const owner = await user('Media Owner', '1');
  const chair = await user('Media Chair', '2');
  const shared = await user('Shared Member', '3');
  const outsider = await user('Outsider', '4');
  const platformAdmin = await user('Platform Admin', '5', true);
  const chama = (await db.query<{ id: string }>(
    `INSERT INTO chamas (name,type,status,visibility,contribution_amount,contribution_frequency,created_by)
     VALUES ('Media Chama','goal_based','active','application',1000,'monthly',$1) RETURNING id`, [chair],
  )).rows[0].id;
  await member(chama, chair, 'chairperson');
  await member(chama, owner);
  await member(chama, shared);


  await t.test('arbitrary external avatar/logo URLs are rejected by API validation', () => {
    assert.throws(() => updateMyProfileSchema.parse({ avatarUrl: 'https://evil.example/avatar.png' }));
    assert.throws(() => updateChamaSchema.parse({ logo_url: 'https://evil.example/logo.png' }));
  });


  await t.test('support attachment scope is derived only from the ticket', () => {
    assert.throws(() => createUploadSchema.parse({
      purpose: 'support_ticket_attachment',
      ticketId: randomUUID(),
      chamaId: randomUUID(),
      fileName: 'evidence.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    }));
  });


  await t.test('profile avatar is invisible before scan, then linked atomically after a clean verdict', async () => {
    const created = await uploads.createUpload(owner, {
      purpose: 'profile_avatar', fileName: 'avatar.png', mimeType: 'image/png', sizeBytes: 2048,
    });
    const uploadId = created.upload.id;
    assert.equal(created.uploadUrl, 'https://storage.test/form');
    assert.equal(created.uploadMethod, 'POST');
    assert.equal(created.uploadFields['Content-Type'], 'image/png');
    const objectKey = await putObjectFor(uploadId, 2048, 'image/png');
    const pending = await uploads.completeUpload(owner, uploadId);
    assert.equal(pending.state, 'scan_pending');
    await assert.rejects(
      () => uploads.createDownload(owner, uploadId),
      (error: { code?: string }) => error.code === 'UPLOAD_NOT_CLEAN',
    );


    const clean = await scanClean(uploadId, 'image/png');
    assert.equal(clean.state, 'clean');
    assert.equal(clean.sha256, 'a'.repeat(64));
    const avatar = (await db.query<{ avatar_url: string }>(`SELECT avatar_url FROM users WHERE id = $1`, [owner])).rows[0].avatar_url;
    assert.equal(avatar, `/api/v1/uploads/${uploadId}/content`);
    assert.match((await uploads.createDownload(owner, uploadId)).downloadUrl, /^https:\/\/storage\.test\/get\//);
    assert.match((await uploads.createDownload(shared, uploadId)).downloadUrl, /^https:\/\/storage\.test\/get\//);
    await assert.rejects(
      () => uploads.createDownload(outsider, uploadId),
      (error: { code?: string }) => error.code === 'UPLOAD_ACCESS_FORBIDDEN',
    );
    assert.ok(storage.objects.has(objectKey));
  });


  await t.test('Chama logo is restricted to leadership and public Chama content can redirect only after scan', async () => {
    await assert.rejects(
      () => uploads.createUpload(owner, { purpose: 'chama_logo', chamaId: chama, fileName: 'logo.webp', mimeType: 'image/webp', sizeBytes: 1000 }),
      (error: { code?: string }) => error.code === 'UPLOAD_CHAMA_LOGO_FORBIDDEN',
    );
    const created = await uploads.createUpload(chair, {
      purpose: 'chama_logo', chamaId: chama, fileName: 'logo.webp', mimeType: 'image/webp', sizeBytes: 1000,
    });
    await putObjectFor(created.upload.id, 1000, 'image/webp');
    await uploads.completeUpload(chair, created.upload.id);
    await scanClean(created.upload.id, 'image/webp');
    const logo = (await db.query<{ logo_url: string }>(`SELECT logo_url FROM chamas WHERE id = $1`, [chama])).rows[0].logo_url;
    assert.equal(logo, `/api/v1/uploads/${created.upload.id}/content`);
    const publicRedirect = await uploads.createContentRedirect(null, created.upload.id);
    assert.match(publicRedirect.downloadUrl, /^https:\/\/storage\.test\/get\//);
  });


  await t.test('support attachments inherit ticket privacy and appear only after a clean scan', async () => {
    const ticket = await support.createTicket(owner, {
      category: 'chama_issue', subject: 'Attachment test', message: 'I have evidence to attach.', chamaId: chama,
    });
    const created = await uploads.createUpload(owner, {
      purpose: 'support_ticket_attachment', ticketId: ticket.id,
      fileName: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: 4096,
    });
    await putObjectFor(created.upload.id, 4096, 'application/pdf');
    await uploads.completeUpload(owner, created.upload.id);
    const before = await support.getTicket(owner, ticket.id);
    assert.equal(before.attachments.length, 0);
    await scanClean(created.upload.id, 'application/pdf');
    const after = await support.getTicket(owner, ticket.id);
    assert.equal(after.attachments.length, 1);
    assert.equal(after.attachments[0].id, created.upload.id);
    assert.equal(after.attachments[0].contentPath, `/api/v1/uploads/${created.upload.id}/content`);
    await assert.rejects(
      () => uploads.createDownload(outsider, created.upload.id),
      (error: { code?: string }) => error.code === 'UPLOAD_TICKET_FORBIDDEN',
    );
    assert.match((await uploads.createDownload(platformAdmin, created.upload.id)).downloadUrl, /^https:\/\/storage\.test\/get\//);
  });


  await t.test('infected or MIME-mismatched objects are never served and are deleted best-effort', async () => {
    const infected = await uploads.createUpload(owner, {
      purpose: 'profile_avatar', fileName: 'bad.jpg', mimeType: 'image/jpeg', sizeBytes: 500,
    });
    const infectedKey = await putObjectFor(infected.upload.id, 500, 'image/jpeg');
    await uploads.completeUpload(owner, infected.upload.id);
    let claims = await uploads.claimScans(20);
    let claim = claims.find((item) => item.id === infected.upload.id)!;
    const infectedResult = await uploads.recordScanResult(infected.upload.id, {
      claimToken: claim.claimToken!, verdict: 'infected', provider: 'test-scanner', reference: 'virus-1',
    });
    assert.equal(infectedResult.state, 'infected');
    assert.ok(storage.deleted.includes(infectedKey));
    await assert.rejects(() => uploads.createDownload(owner, infected.upload.id), (error: { code?: string }) => error.code === 'UPLOAD_NOT_CLEAN');


    const mismatch = await uploads.createUpload(owner, {
      purpose: 'profile_avatar', fileName: 'fake.png', mimeType: 'image/png', sizeBytes: 600,
    });
    const mismatchKey = await putObjectFor(mismatch.upload.id, 600, 'image/png');
    await uploads.completeUpload(owner, mismatch.upload.id);
    claims = await uploads.claimScans(20);
    claim = claims.find((item) => item.id === mismatch.upload.id)!;
    const rejected = await uploads.recordScanResult(mismatch.upload.id, {
      claimToken: claim.claimToken!, verdict: 'clean', provider: 'test-scanner', detectedMimeType: 'image/jpeg', sha256: 'b'.repeat(64),
    });
    assert.equal(rejected.state, 'rejected');
    assert.ok(storage.deleted.includes(mismatchKey));
  });


  await t.test('storage identity cannot be retargeted after intent creation', async () => {
    const created = await uploads.createUpload(owner, {
      purpose: 'profile_avatar', fileName: 'immutable.png', mimeType: 'image/png', sizeBytes: 100,
    });
    await assert.rejects(
      () => db.query(`UPDATE media_uploads SET object_key = 'uploads/tampered' WHERE id = $1`, [created.upload.id]),
      /immutable/i,
    );
  });
});