const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { pool } = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

// Validation schemas
const wingSchema = Joi.object({
  society_id: Joi.string().required(),
  name: Joi.string().required().min(1).max(100),
  description: Joi.string().optional(),
  total_floors: Joi.number().integer().min(0).default(0)
});

// Get all wings
router.get('/', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      `SELECT w.id, w.society_id, w.name, w.description, w.total_floors, w.created_at, w.updated_at,
              .updated_at, s.name as society_name
       FROM wings w
       JOIN societies s ON w.society_id = s.id
       ORDER BY s.name, w.name`
    );

    res.status(200).json({
      success: true,
      data: {
        wings: result.rows
      }
    });
  } catch (error) {
    console.error('Get wings error:', error);
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

// Get wings by society ID
router.get('/society/:societyId', authenticateToken, async (req, res) => {
  let client;
  try {
    const { societyId } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT w.id, w.society_id, w.name, w.description, w.total_floors, w.created_at, w.updated_at
       FROM wings w
       WHERE w.society_id = $1
       ORDER BY w.name`,
      [societyId]
    );

    res.status(200).json({
      success: true,
      data: {
        wings: result.rows
      }
    });
  } catch (error) {
    console.error('Get wings by society error:', error);
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

// Get wing by ID
router.get('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT w.id, w.society_id, w.name, w.description, w.total_floors, w.created_at, w.updated_at,
              s.name as society_name
       FROM wings w
       JOIN societies s ON w.society_id = s.id
       WHERE w.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Wing not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        wing: result.rows[0]
      }
    });
  } catch (error) {
    console.error('Get wing by ID error:', error);
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

// Create a new wing
router.post('/', authenticateToken, authorizeRole('admin', 'resident'), async (req, res) => {
  let client;
  try {
    const { error, value } = wingSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Verify society exists and user has access
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

    // Check if wing name already exists for this society
    const duplicateCheck = await client.query(
      'SELECT id FROM wings WHERE society_id = $1 AND name = $2',
      [value.society_id, value.name]
    );

    if (duplicateCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Wing with this name already exists in this society'
      });
    }
    const result = await client.query(
      `INSERT INTO wings (society_id, name, description, total_floors, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, society_id, name, description, total_floors, created_at, updated_at`,
      [
        value.society_id,
        value.name,
        value.description,
        value.total_floors,
        req.user.userId
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Wing created successfully',
      data: {
        wing: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Create wing error:', error);
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

// Update wing
router.put('/:id', authenticateToken, authorizeRole('admin', 'resident'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { error, value } = wingSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if wing exists
    const checkResult = await client.query('SELECT society_id FROM wings WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Wing not found'
      });
    }

    const societyId = checkResult.rows[0].society_id;

    // Check if wing name already exists for this society (excluding current wing)
    if (value.name) {
      const duplicateCheck = await client.query(
        'SELECT id FROM wings WHERE society_id = $1 AND name = $2 AND id != $3',
        [societyId, value.name, id]
      );

      if (duplicateCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Wing with this name already exists in this society'
        });
      }
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

    // Add wing ID for WHERE clause
    values.push(id);

    const queryText = `
      UPDATE wings
      SET ${updates.join(', ')}
      WHERE id = $${index}
      RETURNING id, society_id, name, description, total_floors, created_at, updated_at
    `;

    const result = await client.query(queryText, values);
    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Wing updated successfully',
      data: {
        wing: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update wing error:', error);
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

// Delete wing
router.delete('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if wing exists
    const checkResult = await client.query('SELECT id FROM wings WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Wing not found'
      });
    }

    // Delete wing (will cascade to related flats)
    await client.query('DELETE FROM wings WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Wing deleted successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Delete wing error:', error);
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