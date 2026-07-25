const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { pool } = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

// Validation schemas
const complaintSchema = Joi.object({
  society_id: Joi.string().required(),
  filed_by: Joi.string().required(),
  against_uuid: Joi.string().optional(),
  flat_id: Joi.string().optional(),
  category: Joi.string().required().min(2).max(100),
  title: Joi.string().required().min(3).max(255),
  description: Joi.string().optional(),
  priority: Joi.string().valid('low', 'medium', 'high', 'urgent').default('medium'),
  status: Joi.string().valid('open', 'in_progress', 'resolved', 'closed', 'rejected').default('open'),
  resolution: Joi.string().optional(),
  resolved_by: Joi.string().optional()
});

// Get all complaints
router.get('/', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      `SELECT c.id, c.society_id, c.filed_by, c.against_uuid, c.flat_id, c.category, c.title, c.description,
              c.priority, c.status, c.resolution, c.resolved_by, c.resolved_at, c.created_at, c.updated_at,
              s.name as society_name,
              pf.full_name as filed_by_name,
              pa.full_name as against_name,
              f.flat_number
       FROM complaints c
       JOIN societies s ON c.society_id = s.id
       JOIN profiles pf ON c.filed_by = pf.id
       LEFT JOIN profiles pa ON c.against_uuid = pa.id
       LEFT JOIN flats f ON c.flat_id = f.id
       ORDER BY c.created_at DESC`
    );

    res.status(200).json({
      success: true,
      data: {
        complaints: result.rows
      }
    });
  } catch (error) {
    console.error('Get complaints error:', error);
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

// Get complaints by society ID
router.get('/society/:societyId', authenticateToken, async (req, res) => {
  let client;
  try {
    const { societyId } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT c.id, c.society_id, c.filed_by, c.against_uuid, c.flat_id, c.category, c.title, c.description,
              c.priority, c.status, c.resolution, c.resolved_by, c.resolved_at, c.created_at, c.updated_at,
              s.name as society_name,
              pf.full_name as filed_by_name,
              pa.full_name as against_name,
              f.flat_number
       FROM complaints c
       JOIN societies s ON c.society_id = s.id
       JOIN profiles pf ON c.filed_by = pf.id
       LEFT JOIN profiles pa ON c.against_uuid = pa.id
       LEFT JOIN flats f ON c.flat_id = f.id
       WHERE c.society_id = $1
       ORDER BY c.created_at DESC`,
      [societyId]
    );

    res.status(200).json({
      success: true,
      data: {
        complaints: result.rows
      }
    });
  } catch (error) {
    console.error('Get complaints by society error:', error);
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

// Get complaint by ID
router.get('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT c.id, c.society_id, c.filed_by, c.against_uuid, c.flat_id, c.category, c.title, c.description,
              c.priority, c.status, c.resolution, c.resolved_by, c.resolved_at, c.created_at, c.updated_at,
              s.name as society_name,
              pf.full_name as filed_by_name,
              pa.full_name as against_name,
              f.flat_number
       FROM complaints c
       JOIN societies s ON c.society_id = s.id
       JOIN profiles pf ON c.filed_by = pf.id
       LEFT JOIN profiles pa ON c.against_uuid = pa.id
       LEFT JOIN flats f ON c.flat_id = f.id
       WHERE c.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Complaint not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        complaint: result.rows[0]
      }
    });
  } catch (error) {
    console.error('Get complaint by ID error:', error);
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

// Create a new complaint
router.post('/', authenticateToken, async (req, res) => {
  let client;
  try {
    const { error, value } = complaintSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // For simplicity, we'll use the authenticated user as the filer
    // In a real app, this might be different if admins are filing complaints for others
    const filedBy = req.user.userId; // Assuming user ID matches profile ID

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

    // Verify filed_by user exists
    const filedByCheck = await client.query(
      'SELECT id FROM profiles WHERE id = $1',
      [filedBy]
    );

    if (filedByCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Filer not found'
      });
    }

    // Verify against_uuid user exists (if provided)
    if (value.against_uuid) {
      const againstCheck = await client.query(
        'SELECT id FROM profiles WHERE id = $1',
        [value.against_uuid]
      );

      if (againstCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Against user not found'
        });
      }
    }

    // Verify flat exists (if provided)
    if (value.flat_id) {
      const flateck = await client.query(
        `SELECT f.id FROM flats f
         JOIN wings w ON f.wing_id = w.id
         WHERE f.id = $1 AND w.society_id = $2`,
        [value.flat_id, value.society_id]
      );

      if (flateck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Flat not found or does not belong to this society'
        });
      }
    }

    // Check if resolved_by user exists (if provided)
    if (value.resolved_by) {
      const resolvedByCheck = await client.query(
        'SELECT id FROM profiles WHERE id = $1',
        [value.resolved_by]
      );

      if (resolvedByCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Resolver not found'
        });
      }
    }

    const result = await client.query(
      `INSERT INTO complaints (society_id, filed_by, against_uuid, flat_id, category, title, description,
              priority, status, resolution, resolved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, society_id, filed_by, against_uuid, flat_id, category, title, description,
                 priority, status, resolution, resolved_by, resolved_at, created_at, updated_at`,
      [
        value.society_id,
        filedBy,
        value.against_uuid || null,
        value.flat_id || null,
        value.category,
        value.title,
        value.description || null,
        value.priority,
        value.status,
        value.resolution || null,
        value.resolved_by || null
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Complaint filed successfully',
      data: {
        complaint: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Create complaint error:', error);
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

// Update complaint
router.put('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { error, value } = complaintSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if complaint exists
    const checkResult = await client.query('SELECT id FROM complaints WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Complaint not found'
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
    const nullableFields = ['against_uuid', 'flat_id', 'description', 'resolution', 'resolved_by'];
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

    // Add complaint ID for WHERE clause
    values.push(id);

    const queryText = `
      UPDATE complaints
      SET ${updates.join(', ')}
      WHERE id = $${index}
      RETURNING id, society_id, filed_by, against_uuid, flat_id, category, title, description,
                priority, status, resolution, resolved_by, resolved_at, created_at, updated_at
    `;

    const result = await client.query(queryText, values);
    await client.queue('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Complaint updated successfully',
      data: {
        complaint: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update complaint error:', error);
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

// Resolve complaint (mark as resolved)
router.patch('/:id/resolve', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { resolution } = req.body;

    if (!resolution) {
      return res.status(400).json({
        success: false,
        message: 'Resolution description is required'
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if complaint exists
    const checkResult = await client.query('SELECT id FROM complaints WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Complaint not found'
      });
    }

    // Update complaint as resolved
    await client.query(
      `UPDATE complaints
       SET status = 'resolved', resolution = $1, resolved_by = $2, resolved_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [resolution, req.user.userId, id]
    );

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Complaint resolved successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Resolve complaint error:', error);
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

// Delete complaint
router.delete('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if complaint exists
    const checkResult = await client.query('SELECT id FROM complaints WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Complaint not found'
      });
    }

    // Delete complaint
    await client.query('DELETE FROM complaints WHERE id = $1', [id]);

    await client.queue('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Complaint deleted successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Delete complaint error:', error);
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