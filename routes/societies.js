const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { pool } = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

// Validation schemas
const societySchema = Joi.object({
  name: Joi.string().required().min(2).max(255),
  address: Joi.string().required().min(5),
  city: Joi.string().required(),
  state: Joi.string().required(),
  postal_code: Joi.string().optional(),
  country: Joi.string().default('India'),
  contact_number: Joi.string().optional(),
  email: Joi.string().email().optional(),
  website: Joi.string().uri().optional(),
  established_year: Joi.number().integer().min(1900).max(new Date().getFullYear()).optional()
});

// Get all societies
router.get('/', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      'SELECT id, name, address, city, state, postal_code, country, contact_number, email, website, established_year, total_towers, total_flats, created_at, updated_at FROM societies ORDER BY name'
    );

    res.status(200).json({
      success: true,
      data: {
        societies: result.rows
      }
    });
  } catch (error) {
    console.error('Get societies error:', error);
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

// Get society by ID
router.get('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();

    const result = await client.query(
      'SELECT id, name, address, city, state, postal_code, country, contact_number, email, website, established_year, total_towers, total_flats, created_at, updated_at FROM societies WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Society not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        society: result.rows[0]
      }
    });
  } catch (error) {
    console.error('Get society by ID error:', error);
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

// Create a new society
router.post('/', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { error, value } = societySchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO societies (name, address, city, state, postal_code, country, contact_number, email, website, established_year, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, name, address, city, state, postal_code, country, contact_number, email, website, established_year, total_towers, total_flats, created_at, updated_at`,
      [
        value.name,
        value.address,
        value.city,
        value.state,
        value.postal_code,
        value.country,
        value.contact_number,
        value.email,
        value.website,
        value.established_year,
        req.user.userId
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Society created successfully',
      data: {
        society: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Create society error:', error);
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

// Update society
router.put('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { error, value } = societySchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if society exists
    const checkResult = await client.query('SELECT id FROM societies WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Society not found'
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

    // Add society ID for WHERE clause
    values.push(id);

    const queryText = `
      UPDATE societies
      SET ${updates.join(', ')}
      WHERE id = $${index}
      RETURNING id, name, address, city, state, postal_code, country, contact_number, email, website, established_year, total_towers, total_flats, created_at, updated_at
    `;

    const result = await client.query(queryText, values);
    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Society updated successfully',
      data: {
        society: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update society error:', error);
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

// Delete society
router.delete('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if society exists
    const checkResult = await client.query('SELECT id FROM societies WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Society not found'
      });
    }

    // Delete society (will cascade to related tables)
    await client.query('DELETE FROM societies WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Society deleted successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Delete society error:', error);
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