const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { pool } = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

// Validation schemas
const maintenanceRequestSchema = Joi.object({
  society_id: Joi.string().required(),
  flat_id: Joi.string().optional(),
  reported_by: Joi.string().required(),
  assigned_to: Joi.string().optional(),
  category: Joi.string().required().min(2).max(100),
  title: Joi.string().required().min(3).max(255),
  description: Joi.string().optional(),
  priority: Joi.string().valid('low', 'medium', 'high', 'urgent').default('medium'),
  status: Joi.string().valid('open', 'in_progress', 'resolved', 'closed', 'rejected').default('open'),
  estimated_cost: Joi.number().precision(2).min(0),
  actual_cost: Joi.number().precision(2).min(0),
  scheduled_date: Joi.date().iso().optional(),
  completed_date: Joi.date().iso().optional()
});

// Get all maintenance requests
router.get('/', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      `SELECT mr.id, mr.society_id, mr.flat_id, mr.reported_by, mr.assigned_to, mr.category, mr.title, mr.description,
              mr.priority, mr.status, mr.estimated_cost, mr.actual_cost, mr.scheduled_date, mr.completed_date,
              mr.resolution_notes, mr.created_at, mr.updated_at,
              s.name as society_name,
              f.flat_number,
              reporter.full_name as reported_by_name,
              assignee.full_name as assigned_to_name
       FROM maintenance_requests mr
       JOIN societies s ON mr.society_id = s.id
       LEFT JOIN flats f ON mr.flat_id = f.id
       LEFT JOIN profiles reporter ON mr.reported_by = reporter.id
       LEFT JOIN profiles assignee ON mr.assigned_to = assignee.id
       ORDER BY mr.created_at DESC`
    );

    res.status(200).json({
      success: true,
      data: {
        maintenance_requests: result.rows
      }
    });
  } catch (error) {
    console.error('Get maintenance requests error:', error);
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

// Get maintenance requests by society ID
router.get('/society/:societyId', authenticateToken, async (req, res) => {
  let client;
  try {
    const { societyId } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT mr.id, mr.society_id, mr.flat_id, mr.reported_by, mr.assigned_to, mr.category, mr.title, mr.description,
              mr.priority, mr.status, mr.estimated_cost, mr.actual_cost, mr.scheduled_date, mr.completed_date,
              mr.resolution_notes, mr.created_at, mr.updated_at,
              s.name as society_name,
              f.flat_number,
              reporter.full_name as reported_by_name,
              assignee.full_name as assigned_to_name
       FROM maintenance_requests mr
       JOIN societies s ON mr.society_id = s.id
       LEFT JOIN flats f ON mr.flat_id = f.id
       LEFT JOIN profiles reporter ON mr.reported_by = reporter.id
       LEFT JOIN profiles assignee ON mr.assigned_to = assignee.id
       WHERE mr.society_id = $1
       ORDER BY mr.created_at DESC`,
      [societyId]
    );

    res.status(200).json({
      success: true,
      data: {
        maintenance_requests: result.rows
      }
    });
  } catch (error) {
    console.error('Get maintenance requests by society error:', error);
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

// Get maintenance request by ID
router.get('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT mr.id, mr.society_id, mr.flat_id, mr.reported_by, mr.assigned_to, mr.category, mr.title, mr.description,
              mr.priority, mr.status, mr.estimated_cost, mr.actual_cost, mr.scheduled_date, mr.completed_date,
              mr.resolution_notes, mr.created_at, mr.updated_at,
              s.name as society_name,
              f.flat_number,
              reporter.full_name as reported_by_name,
              assignee.full_name as assigned_to_name
       FROM maintenance_requests mr
       JOIN societies s ON mr.society_id = s.id
       LEFT JOIN flats f ON mr.flat_id = f.id
       LEFT JOIN profiles reporter ON mr.reported_by = reporter.id
       LEFT JOIN profiles assignee ON mr.assigned_to = assignee.id
       WHERE mr.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Maintenance request not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        maintenance_request: result.rows[0]
      }
    });
  } catch (error) {
    console.error('Get maintenance request by ID error:', error);
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

// Create a new maintenance request
router.post('/', authenticateToken, async (req, res) => {
  let client;
  try {
    const { error, value } = maintenanceRequestSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // For simplicity, we'll use the authenticated user as the reporter
    // In a more complex system, this might come from the request body
    const reportedBy = req.user.userId;

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

    // Verify flat exists (if provided)
    if (value.flat_id) {
      const flatCheck = await client.query(
        `SELECT f.id FROM flats f
         JOIN wings w ON f.wing_id = w.id
         WHERE f.id = $1 AND w.society_id = $2`,
        [value.flat_id, value.society_id]
      );

      if (flatCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Flat not found or does not belong to this society'
        });
      }
    }

    // Verify assigned_to user exists (if provided)
    if (value.assigned_to) {
      const assignedToCheck = await client.query(
        'SELECT id FROM profiles WHERE id = $1',
        [value.assigned_to]
      );

      if (assignedToCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Assigned user not found'
        });
      }
    }

    const result = await client.query(
      `INSERT INTO maintenance_requests (society_id, flat_id, reported_by, assigned_to, category, title, description,
              priority, status, estimated_cost, actual_cost, scheduled_date, completed_date, resolution_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, society_id, flat_id, reported_by, assigned_to, category, title, description,
                 priority, status, estimated_cost, actual_cost, scheduled_date, completed_date,
                 resolution_notes, created_at, updated_at`,
      [
        value.society_id,
        value.flat_id || null,
        reportedBy,
        value.assigned_to || null,
        value.category,
        value.title,
        value.description || null,
        value.priority,
        value.status,
        value.estimated_cost || null,
        value.actual_cost || null,
        value.scheduled_date || null,
        value.completed_date || null,
        value.resolution_notes || null
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Maintenance request created successfully',
      data: {
        maintenance_request: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Create maintenance request error:', error);
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

// Update maintenance request
router.put('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { error, value } = maintenanceRequestSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if maintenance request exists
    const checkResult = await client.query('SELECT id FROM maintenance_requests WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Maintenance request not found'
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
    const nullableFields = ['flat_id', 'assigned_to', 'description', 'estimated_cost', 'actual_cost',
                           'scheduled_date', 'completed_date', 'resolution_notes'];
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

    // Add maintenance request ID for WHERE clause
    values.push(id);

    const queryText = `
      UPDATE maintenance_requests
      SET ${updates.join(', ')}
      WHERE id = $${index}
      RETURNING id, society_id, flat_id, reported_by, assigned_to, category, title, description,
                priority, status, estimated_cost, actual_cost, scheduled_date, completed_date,
                resolution_notes, created_at, updated_at
    `;

    const result = await client.query(queryText, values);
    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Maintenance request updated successfully',
      data: {
        maintenance_request: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update maintenance request error:', error);
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

// Delete maintenance request
router.delete('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if maintenance request exists
    const checkResult = await client.query('SELECT id FROM maintenance_requests WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Maintenance request not found'
      });
    }

    // Delete maintenance request
    await client.query('DELETE FROM maintenance_requests WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Maintenance request deleted successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Delete maintenance request error:', error);
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