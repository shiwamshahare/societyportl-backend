const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { pool } = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

// Validation schemas
const flatSchema = Joi.object({
  wing_id: Joi.string().required(),
  flat_number: Joi.string().required().min(1).max(20),
  floor_number: Joi.number().integer().min(0),
  bhk_configuration: Joi.string().pattern(/^\d+BHK$/).optional(),
  square_feet: Joi.number().integer().min(0),
  status: Joi.string().valid('available', 'occupied', 'vacant', 'maintenance').default('available'),
  monthly_rent: Joi.number().precision(2).min(0),
  maintenance_fee: Joi.number().precision(2).min(0).default(0.00)
});

// Get all flats
router.get('/', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      `SELECT f.id, f.wing_id, f.flat_number, f.floor_number, f.bhk_configuration, f.square_feet, f.status,
              f.monthly_rent, f.maintenance_fee, f.created_at, f.updated_at,
              w.name as wing_name, w.society_id, s.name as society_name
       FROM flats f
       JOIN wings w ON f.wing_id = w.id
       JOIN societies s ON w.society_id = s.id
       ORDER BY w.name, f.floor_number, f.flat_number`
    );

    res.status(200).json({
      success: true,
      data: {
        flats: result.rows
      }
    });
  } catch (error) {
    console.error('Get flats error:', error);
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

// Get flats by wing ID
router.get('/wing/:wingId', authenticateToken, async (req, res) => {
  let client;
  try {
    const { wingId } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT f.id, f.wing_id, f.flat_number, f.floor_number, f.bhk_configuration, f.square_feet, f.status,
              f.monthly_rent, f.maintenance_fee, f.created_at, f.updated_at,
              w.name as wing_name, w.society_id, s.name as society_name
       FROM flats f
       JOIN wings w ON f.wing_id = w.id
       JOIN societies s ON w.society_id = s.id
       WHERE f.wing_id = $1
       ORDER BY f.floor_number, f.flat_number`,
      [wingId]
    );

    res.status(200).json({
      success: true,
      data: {
        flats: result.rows
      }
    });
  } catch (error) {
    console.error('Get flats by wing error:', error);
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

// Get flat by ID
router.get('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT f.id, f.wing_id, f.flat_number, f.floor_number, f.bhk_configuration, f.square_feet, f.status,
              f.monthly_rent, f.maintenance_fee, f.created_at, f.updated_at,
              w.name as wing_name, w.society_id, s.name as society_name
       FROM flats f
       JOIN wings w ON f.wing_id = w.id
       JOIN societies s ON w.society_id = s.id
       WHERE f.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Flat not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        flat: result.rows[0]
      }
    });
  } catch (error) {
    console.error('Get flat by ID error:', error);
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

// Create a new flat
router.post('/', authenticateToken, authorizeRole('admin', 'resident'), async (req, res) => {
  let client;
  try {
    const { error, value } = flatSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Verify wing exists
    const wingCheck = await client.query(
      `SELECT w.id, w.society_id FROM wings w WHERE w.id = $1`,
      [value.wing_id]
    );

    if (wingCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Wing not found'
      });
    }

    // Check if flat number already exists for this wing
    const duplicateCheck = await client.query(
      'SELECT id FROM flats WHERE wing_id = $1 AND flat_number = $2',
      [value.wing_id, value.flat_number]
    );

    if (duplicateCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Flat with this number already exists in this wing'
      });
    }

    const result = await client.query(
      `INSERT INTO flats (wing_id, flat_number, floor_number, bhk_configuration, square_feet, status, monthly_rent, maintenance_fee, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, wing_id, flat_number, floor_number, bhk_configuration, square_feet, status, monthly_rent, maintenance_fee, created_at, updated_at`,
      [
        value.wing_id,
        value.flat_number,
        value.floor_number,
        value.bhk_configuration,
        value.square_feet,
        value.status,
        value.monthly_rent,
        value.maintenance_fee,
        req.user.userId
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Flat created successfully',
      data: {
        flat: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Create flat error:', error);
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

// Update flat
router.put('/:id', authenticateToken, authorizeRole('admin', 'resident'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { error, value } = flatSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if flat exists and get wing_id for duplicate check
    const checkResult = await client.query('SELECT wing_id FROM flats WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Flat not found'
      });
    }

    const wingId = checkResult.rows[0].wing_id;

    // Check if flat number already exists for this wing (excluding current flat)
    if (value.flat_number) {
      const duplicateCheck = await client.query(
        'SELECT id FROM flats WHERE wing_id = $1 AND flat_number = $2 AND id != $3',
        [wingId, value.flat_number, id]
      );

      if (duplicateCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Flat with this number already exists in this wing'
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

    // Add flat ID for WHERE clause
    values.push(id);

    const queryText = `
      UPDATE flats
      SET ${updates.join(', ')}
      WHERE id = $${index}
      RETURNING id, wing_id, flat_number, floor_number, bhk_configuration, square_feet, status, monthly_rent, maintenance_fee, created_at, updated_at
    `;

    const result = await client.query(queryText, values);
    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Flat updated successfully',
      data: {
        flat: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update flat error:', error);
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

// Delete flat
router.delete('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if flat exists
    const checkResult = await client.query('SELECT id FROM flats WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Flat not found'
      });
    }

    // Delete flat
    await client.query('DELETE FROM flats WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Flat deleted successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Delete flat error:', error);
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