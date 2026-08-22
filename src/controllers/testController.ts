import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { prisma } from '../lib/prisma';
import { eventBroadcaster } from '../services/eventBroadcaster';

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const trafficLogPath = path.join(logsDir, 'traffic.log');

export const handleTestDiagnostics = async (req: Request, res: Response): Promise<void> => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    endpoint: req.originalUrl || req.path,
    method: req.method,
    headers: req.headers,
    queryParams: req.query,
    body: req.body,
    ip: req.ip || req.socket.remoteAddress,
  };

  const formattedLog = `\n[${timestamp}] ${req.method} ${req.originalUrl}\nHeaders: ${JSON.stringify(req.headers)}\nQuery: ${JSON.stringify(req.query)}\nBody: ${JSON.stringify(req.body)}\n----------------------------------------\n`;

  // Log to console & traffic.log file
  console.log(`🔍 [DIAGNOSTIC] ${req.method} ${req.originalUrl}`);
  fs.appendFileSync(trafficLogPath, formattedLog);

  // Store in database
  try {
    await prisma.trafficLog.create({
      data: {
        endpoint: req.originalUrl,
        method: req.method,
        headers: JSON.stringify(req.headers),
        queryParams: JSON.stringify(req.query),
        body: JSON.stringify(req.body),
        ip: req.ip || req.socket.remoteAddress,
      },
    });
  } catch (err) {
    console.error('Failed to persist traffic log to DB:', err);
  }

  // Broadcast to Developer Workbench via SSE
  eventBroadcaster.broadcast('TRAFFIC_DIAGNOSTIC', logEntry);

  res.status(200).json({
    code: 0,
    msg: 'Diagnostic request logged successfully',
    diagnosticData: logEntry,
  });
};
