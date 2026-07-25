const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { pool } = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

// Validation schemas
const notificationSchema = Joi.object({
  society_id: Joi.string().required(),
  title: Joi.string().required().min(3).max(255),
  message: Joi.string().required().min(10),
  notification_type: Joi.string().valid('announcement', 'alert', 'event', 'maintenance', 'payment').default('announcement'),
  priority: Joi.string().valid('low', 'normal', 'high', 'urgent').default('normal'),
  target_audience: Joi.string().valid('all', 'residents', 'owners', 'tenants', 'staff').default('all'),
  is_active: Joi.boolean().default(true),
  starts_at: Joi.date().iso().optional(),
  ends_at: Joi.date().iso().optional().greater(Joi.ref('starts_at'))
});

// Get all notifications
router.get('/', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      `SELECT n.id, n.society_id, n.title, n.message, n.notification_type, n.priority, n.target_audience, n.is_active,
              n.starts_at, n.ends_at, n.created_at, n.updated_at,
              s.name as society_name,
              u.full_name as created_by_name
       FROM notifications n
       JOIN societies s ON n.society_id = s.id
       JOIN users u ON n.created_by = u.id
       ORDER BY n.created_at DESC`
    );

    res.status(200).json({
      success: true,
      data: {
        notifications: result.rows
      }
    });
  } catch (error) {
    console.error('Get notifications error:', error);
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

// Get notifications by society ID
router.get('/society/:societyId', authenticateToken, async (req, res) => {
  let client;
  try {
    const { societyId } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT n.id, n.society_id, n.title, n.message, n.notification_type, n.priority, n.target_audience, n.is_active,
              n.starts_at, n.ends_at, n.created_at, n.updated_at,
              s.name as society_name,
              u.full_name as created_by_name
       FROM notifications n
       JOIN societies s ON n.society_id = s.id
       JOIN users u ON n.created_by = u.id
       WHERE n.society_id = $1
       ORDER BY n.created_at DESC`,
      [societyId]
    );

    res.status(200).json({
      success: true,
      data: {
        notifications: result.rows
      }
    });
  } catch (error) {
    console.error('Get notifications by society error:', error);
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

// Get notification by ID
router.get('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT n.id, n.society_id, n.title, n.message, n.notification_type, n.priority, n.target_audience, n.is_active,
              n.starts_at, n.ends_at, n.created_at, n.updated_at,
              s.name as society_name,
              u.full_name as created_by_name
       FROM notifications n
       JOIN societies s ON n.society_id = s.id
       JOIN users u ON n.created_by = u.id
       WHERE n.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        notification: result.rows[0]
      }
    });
  } catch (error) {
    console.error('Get notification by ID error:', error);
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

// Create a new notification
router.post('/', authenticateToken, authorizeRole('admin', 'resident'), async (req, res) => {
  let client;
  try {
    const { error, value } = notificationSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Validate date range if both dates are provided
    if (value.starts_at && value.ends_at && new Date(value.ends_at) <= new Date(value.starts_at)) {
      return res.status(400).json({
        success: false,
        message: 'End date must be after start date'
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
      return res.status(404).json({
        success: false,
        message: 'Society not found'
      });
    }

    const result = await client.query(
      `INSERT INTO notifications (society_id, title, message, notification_type, priority, target_audience, is_active, starts_at, ends_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, society_id, title, message, notification_type, priority, target_audience, is_active, starts_at, ends_at, created_at, updated_at`,
      [
        value.society_id,
        value.title,
        value.message,
        value.notification_type,
        value.priority,
        value.target_audience,
        value.is_active,
        value.starts_at || null,
        value.ends_at || null,
        req.user.userId
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Notification created successfully',
      data: {
        notification: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Create notification error:', error);
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

// Update notification
router.put('/:id', authenticateToken, authorizeRole('admin', 'resident'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { error, value } = notificationSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Validate date range if both dates are provided
    if (value.starts_at && value.ends_at && new Date(value.ends_at) <= new Date(value.starts_at)) {
      return res.status(400).json({
        success: false,
        message: 'End date must be after start date'
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if notification exists
    const checkResult = await client.query('SELECT id FROM notifications WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let index = 1;

    Object.keys(value).forEach(key => {
      if (value[key] !== undefined) {
        // Handle date validation for start/end times
        if ((key === 'starts_at' || key === 'ends_at') && value[key] === null) {
          updates.push(`${key} = $${index}`);
          values.push(null);
          index++;
        } else if (value[key] !== null && value[key] !== undefined) {
          updates.push(`${key} = $${index}`);
          values.push(value[key]);
          index++;
        }
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

    // Add notification ID for WHERE clause
    values.push(id);

    const queryText = `
      UPDATE notifications
      SET ${updates.join(', ')}
      WHERE id = $${index}
      RETURNING id, society_id, title, message, notification_type, priority, target_audience, is_active, starts_at, ends_at, created_at, updated_at
    `;

    const result = await client.query(queryText, values);
    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Notification updated successfully',
      data: {
        notification: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update notification error:', error);
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

// Delete notification
router.delete('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if notification exists
    const checkResult = await client.query('SELECT id FROM notifications WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    // Delete notification
    await client.query('DELETE FROM notifications WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Delete notification error:', error);
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