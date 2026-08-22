import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';

const logPaymentSchema = z.object({
  transactionId: z.string().min(1, 'Transaction ID is required'),
  vendingMachineCode: z.string().min(1, 'Vending machine code is required'),
  paymentMethod: z.string().min(1, 'Payment method is required'),
  amount: z.number().positive('Amount must be greater than zero'),
  currency: z.string().default('ETB'),
  referenceNumber: z.string().optional(),
  itemId: z.string().optional(),
  itemName: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const logSuccessfulPayment = async (req: Request, res: Response): Promise<void> => {
  try {
    const validated = logPaymentSchema.parse(req.body);

    // Find or auto-create vending machine entry
    let machine = await prisma.vendingMachine.findUnique({
      where: { machineCode: validated.vendingMachineCode },
    });

    if (!machine) {
      machine = await prisma.vendingMachine.create({
        data: {
          machineCode: validated.vendingMachineCode,
          name: `Vending Machine ${validated.vendingMachineCode}`,
          status: 'ONLINE',
        },
      });
    }

    // Save payment log
    const payment = await prisma.paymentLog.create({
      data: {
        transactionId: validated.transactionId,
        vendingMachineId: machine.id,
        paymentMethod: validated.paymentMethod,
        amount: validated.amount,
        currency: validated.currency,
        status: 'SUCCESS',
        referenceNumber: validated.referenceNumber,
        itemId: validated.itemId,
        itemName: validated.itemName,
        metadata: validated.metadata ? JSON.stringify(validated.metadata) : null,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Payment logged successfully',
      data: payment,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.errors,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Failed to log payment',
    });
  }
};

export const getPaymentHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const { machineCode, limit = '20' } = req.query;

    const payments = await prisma.paymentLog.findMany({
      where: machineCode
        ? { vendingMachine: { machineCode: String(machineCode) } }
        : undefined,
      take: Math.min(Number(limit), 100),
      orderBy: { createdAt: 'desc' },
      include: {
        vendingMachine: true,
      },
    });

    res.status(200).json({
      success: true,
      count: payments.length,
      data: payments,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to retrieve payment history',
    });
  }
};
