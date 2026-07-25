const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { pool } = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

// Validation schemas
const paymentSchema = Joi.object({
  society_id: Joi.string().required(),
  payer_uuid: Joi.string().required(),
  payee_uuid: Joi.string().optional(),
  amount: Joi.number().precision(2).required().min(0),
  currency: Joi.string().length(3).default('INR'),
  payment_type: Joi.string().required().min(2).max(50),
  payment_method: Joi.string().optional().max(50),
  transaction_id: Joi.string().optional().max(255),
  status: Joi.string().valid('pending', 'processing', 'completed', 'failed', 'refunded', 'cancelled').default('pending'),
  description: Joi.string().optional(),
  due_date: Joi.date().iso().optional(),
  paid_date: Joi.date().iso().optional(),
  late_fee: Joi.number().precision(2).min(0).default(0.00),
  tax_amount: Joi.number().precision(2).min(0).default(0.00)
});

// Get all payments
router.get('/', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      `SELECT p.id, p.society_id, p.payer_uuid, p.payee_uuid, p.amount, p.currency, p.payment_type, p.payment_method,
              p.transaction_id, p.status, p.description, p.due_date, p.paid_date, p.late_fee, p.tax_amount, p.created_at, p.updated_at,
              s.name as society_name,
              payer.full_name as payer_name,
              payee.full_name as payee_name
       FROM payments p
       JOIN societies s ON p.society_id = s.id
       JOIN profiles payer ON p.payer_uuid = payer.id
       LEFT JOIN profiles payee ON p.payee_uuid = payee.id
       ORDER BY p.created_at DESC`
    );

    res.status(200).json({
      success: true,
      data: {
        payments: result.rows
      }
    });
  } catch (error) {
    console.error('Get payments error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Get payments by society ID
router.get('/society/:societyId', authenticateToken, async (req, res) => {
  let client;
  try {
    const { societyId } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT p.id, p.society_id, p.payer_uuid, p.payee_uuid, p.amount, p.currency, p.payment_type, p.payment_method,
              p.transaction_id, p.status, p.description, p.due_date, p.paid_date, p.late_fee, p.tax_amount, p.created_at, p.updated_at,
              s.name as society_name,
              payer.full_name as payer_name,
              payee.full_name as payee_name
       FROM payments p
       JOIN societies s ON p.society_id = s.id
       JOIN profiles payer ON p.payer_uuid = payer.id
       LEFT JOIN profiles payee ON p.payee_uuid = payee.id
       WHERE p.society_id = $1
       ORDER BY p.created_at DESC`,
      [societyId]
    );

    res.status(200).json({
      success: true,
      data: {
        payments: result.rows
      }
    });
  } catch (error) {
    console.error('Get payments by society error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Get payment by ID
router.get('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT p.id, p.society_id, p.payer_uuid, p.payee_uuid, p.amount, p.currency, p.payment_type, p.payment_method,
              p.transaction_id, p.status, p.description, p.due_date, p.paid_date, p.late_fee, p.tax_amount, p.created_at, p.updated_at,
              s.name as society_name,
              payer.full_name as payer_name,
              payee.full_name as payee_name
       FROM payments p
       JOIN societies s ON p.society_id = s.id
       JOIN profiles payer ON p.payer_uuid = payer.id
       LEFT JOIN profiles payee ON p.payee_uuid = payee.id
       WHERE p.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        payment: result.rows[0]
      }
    });
  } catch (error) {
    console.error('Get payment by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Create a new payment
router.post('/', authenticateToken, async (req, res) => {
  let client;
  try {
    const { error, value } = paymentSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Verify society exists
    const societyCheck = await client.query(
      'SELECT id FROM societies WHERE id = $1',
      [value.society_id]
    );

    if (societyCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Society not found'
      });
    }

    // Verify payer exists
    const payerCheck = await client.query(
      'SELECT id FROM profiles WHERE id = $1',
      [value.payer_uuid]
    );

    if (payerCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Payer not found'
      });
    }

    // Verify payee exists (if provided)
    if (value.payee_uuid) {
      const payeeCheck = await client.query(
        'SELECT id FROM profiles WHERE id = $1',
        [value.payee_uuid]
      );

      if (payeeCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Payee not found'
        });
      }
    }

    // Validate that paid_date is not in the future (if provided)
    if (value.paid_date && new Date(value.paid_date) > new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Paid date cannot be in the future'
      });
    }

    // Validate that due_date is not in the past (if provided)
    if (value.due_date && new Date(value.due_date) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Due date cannot be in the past'
      });
    }

    const result = await client.query(
      `INSERT INTO payments (society_id, payer_uuid, payee_uuid, amount, currency, payment_type, payment_method,
              transaction_id, status, description, due_date, paid_date, late_fee, tax_amount, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, society_id, payer_uuid, payee_uuid, amount, currency, payment_type, payment_method,
                 transaction_id, status, description, due_date, paid_date, late_fee, tax_amount, created_at, updated_at`,
      [
        value.society_id,
        value.payer_uuid,
        value.payee_uuid || null,
        value.amount,
        value.currency,
        value.payment_type,
        value.payment_method || null,
        value.transaction_id || null,
        value.status,
        value.description || null,
        value.due_date || null,
        value.paid_date || null,
        value.late_fee,
        value.tax_amount,
        req.user.userId
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Payment created successfully',
      data: {
        payment: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Create payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Update payment
router.put('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { error, value } = paymentSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if payment exists
    const checkResult = await client.query('SELECT id FROM payments WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Payment not found'
      });
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let index = 1;

    Object.keys(value).forEach(key => {
      if (value[key] !== undefined) {
        updates.push(`${key} = $${index}`);
        values.push(value[key]);
        index++;
      }
    });

    // Handle null values for optional fields
    const nullableFields = ['payee_uuid', 'payment_method', 'transaction_id', 'description', 'due_date', 'paid_date'];
    nullableFields.forEach(field => {
      if (value[field] === null && !updates.some(u => u.startsWith(`${field} =`))) {
        updates.push(`${field} = $${index}`);
        values.push(null);
        index++;
      }
    });

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    // Add updated_at timestamp
    updates.push(`updated_at = $${index}`);
    values.push(new Date());
    index++;

    // Add payment ID for WHERE clause
    values.push(id);

    const queryText = `
      UPDATE payments
      SET ${updates.join(', ')}
      WHERE id = $${index}
      RETURNING id, society_id, payer_uuid, payee_uuid, amount, currency, payment_type, payment_method,
                transaction_id, status, description, due_date, paid_date, late_fee, tax_amount, created_at, updated_at
    `;

    const result = await client.query(queryText, values);
    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Payment updated successfully',
      data: {
        payment: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Delete payment
router.delete('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if payment exists
    const checkResult = await client.query('SELECT id FROM payments WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Payment not found'
      });
    }

    // Delete payment
    await client.query('DELETE FROM payments WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Payment deleted successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Delete payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;