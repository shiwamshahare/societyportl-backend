const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { pool } = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

// Validation schemas
const facilitySchema = Joi.object({
  society_id: Joi.string().required(),
  name: Joi.string().required().min(2).max(255),
  description: Joi.string().optional(),
  category: Joi.string().optional().max(100),
  location_description: Joi.string().optional(),
  capacity: Joi.number().integer().min(0).optional(),
  operating_hours_start: Joi.string().regex(/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/).optional(),
  operating_hours_end: Joi.string().regex(/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/).optional(),
  days_open: Joi.string().optional().max(50),
  maintenance_schedule: Joi.string().optional(),
  is_active: Joi.boolean().default(true),
  booking_required: Joi.boolean().default(false),
  hourly_rate: Joi.number().precision(2).min(0).optional(),
  booking_rules: Joi.string().optional()
});

// Get all facilities
router.get('/', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      `SELECT f.id, f.society_id, f.name, f.description, f.category, f.location_description, f.capacity,
              f.operating_hours_start, f.operating_hours_end, f.days_open, f.maintenance_schedule,
              f.is_active, f.booking_required, f.hourly_rate, f.booking_rules, f.created_at, f.updated_at,
              s.name as society_name
       FROM facilities f
       JOIN societies s ON f.society_id = s.id
       ORDER BY f.name`
    );

    res.status(200).json({
      success: true,
      data: {
        facilities: result.rows
      }
    });
  } catch (error) {
    console.error('Get facilities error:', error);
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

// Get facilities by society ID
router.get('/society/:societyId', authenticateToken, async (req, res) => {
  let client;
  try {
    const { societyId } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT f.id, f.society_id, f.name, f.description, f.category, f.location_description, f.capacity,
              f.operating_hours_start, f.operating_hours_end, f.days_open, f.maintenance_schedule,
              f.is_active, f.booking_required, f.hourly_rate, f.booking_rules, f.created_at, f.updated_at,
              s.name as society_name
       FROM facilities f
       JOIN societies s ON f.society_id = s.id
       WHERE f.society_id = $1
       ORDER BY f.name`,
      [societyId]
    );

    res.status(200).json({
      success: true,
      data: {
        facilities: result.rows
      }
    });
  } catch (error) {
    console.error('Get facilities by society error:', error);
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

// Get facility by ID
router.get('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT f.id, f.society_id, f.name, f.description, f.category, f.location_description, f.capacity,
              f.operating_hours_start, f.operating_hours_end, f.days_open, f.maintenance_schedule,
              f.is_active, f.booking_required, f.hourly_rate, f.booking_rules, f.created_at, f.updated_at,
              s.name as society_name
       FROM facilities f
       JOIN societies s ON f.society_id = s.id
       WHERE f.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Facility not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        facility: result.rows[0]
      }
    });
  } catch (error) {
    console.error('Get facility by ID error:', error);
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

// Create a new facility
router.post('/', authenticateToken, authorizeRole('admin', 'resident'), async (req, res) => {
  let client;
  try {
    const { error, value } = facilitySchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Validate operating hours format
    if (value.operating_hours_start && !/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.test(value.operating_hours_start)) {
      return res.status(400).json({
        success: false,
        message: 'Operating hours start must be in HH:MM format'
      });
    }

    if (value.operating_hours_end && !/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.test(value.operating_hours_end)) {
      return res.status(400).json({
        success: false,
        message: 'Operating hours end must be in HH:MM format'
      });
    }

    // Validate that end time is after start time
    if (value.operating_hours_start && value.operating_hours_end) {
      const startTime = new Date(`1970-01-01T${value.operating_hours_start}:00Z`);
      const endTime = new Date(`1970-01-01T${value.operating_hours_end}:00Z`);
      if (endTime <= startTime) {
        return res.status(400).json({
          success: false,
          message: 'Operating hours end must be after start time'
        });
      }
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

    const result = await client.query(
      `INSERT INTO facilities (society_id, name, description, category, location_description, capacity,
              operating_hours_start, operating_hours_end, days_open, maintenance_schedule,
              is_active, booking_required, hourly_rate, booking_rules, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, society_id, name, description, category, location_description, capacity,
                 operating_hours_start, operating_hours_end, days_open, maintenance_schedule,
                 is_active, booking_required, hourly_rate, booking_rules, created_at, updated_at`,
      [
        value.society_id,
        value.name,
        value.description || null,
        value.category || null,
        value.location_description || null,
        value.capacity || null,
        value.operating_hours_start || null,
        value.operating_hours_end || null,
        value.days_open || null,
        value.maintenance_schedule || null,
        value.is_active,
        value.booking_required,
        value.hourly_rate || null,
        value.booking_rules || null,
        req.user.userId
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Facility created successfully',
      data: {
        facility: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Create facility error:', error);
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

// Update facility
router.put('/:id', authenticateToken, authorizeRole('admin', 'resident'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { error, value } = facilitySchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Validate operating hours format
    if (value.operating_hours_start && !/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.test(value.operating_hours_start)) {
      return res.status(400).json({
        success: false,
        message: 'Operating hours start must be in HH:MM format'
      });
    }

    if (value.operating_hours_end && !/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.test(value.operating_hours_end)) {
      return res.status(400).json({
        success: false,
        message: 'Operating hours end must be in HH:MM format'
      });
    }

    // Validate that end time is after start time
    if (value.operating_hours_start && value.operating_hours_end) {
      const startTime = new Date(`1970-01-01T${value.operating_hours_start}:00Z`);
      const endTime = new Date(`1970-01-01T${value.operating_hours_end}:00Z`);
      if (endTime <= startTime) {
        return res.status(400).json({
          success: false,
          message: 'Operating hours end must be after start time'
        });
      }
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if facility exists
    const checkResult = await client.query('SELECT id FROM facilities WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Facility not found'
      });
    }

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

    // Build update query dynamically
    const updates = [];
    const values = [];
    let index = 1;

    for (const key of Object.keys(value)) {
      if (value[key] !== undefined) {
        // Special handling for time fields to ensure proper format
        if ((key === 'operating_hours_start' || key === 'operating_hours_end') && value[key] !== null) {
          if (!/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.test(value[key])) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              success: false,
              message: `${key} must be in HH:MM format`
            });
          }
        }
        updates.push(`${key} = $${index}`);
        values.push(value[key]);
        index++;
      }
    }

    // Handle null values for optional fields
    const nullableFields = ['description', 'category', 'location_description', 'capacity',
                           'operating_hours_start', 'operating_hours_end', 'days_open',
                           'maintenance_schedule', 'hourly_rate', 'booking_rules'];
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

    // Add facility ID for WHERE clause
    values.push(id);

    const queryText = `
      UPDATE facilities
      SET ${updates.join(', ')}
      WHERE id = $${index}
      RETURNING id, society_id, name, description, category, location_description, capacity,
                operating_hours_start, operating_hours_end, days_open, maintenance_schedule,
                is_active, booking_required, hourly_rate, booking_rules, created_at, updated_at
    `;

    const result = await client.query(queryText, values);
    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Facility updated successfully',
      data: {
        facility: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update facility error:', error);
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

// Delete facility
router.delete('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if facility exists
    const checkResult = await client.query('SELECT id FROM facilities WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Facility not found'
      });
    }

    // Delete facility
    await client.query('DELETE FROM facilities WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Facility deleted successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Delete facility error:', error);
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

// Book a facility
router.post('/:id/book', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id: facilityId } = req.params;
    const userId = req.user.userId;
    const { start_time, end_time, booking_date, purpose } = req.body;

    // Validate required fields
    if (!start_time || !end_time || !booking_date) {
      return res.status(400).json({
        success: false,
        message: 'Start time, end time, and booking date are required'
      });
    }

    // Validate time format
    if (!/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.test(start_time) ||
        !/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.test(end_time)) {
      return res.status(400).json({
        success: false,
        message: 'Time must be in HH:MM format'
      });
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(booking_date)) {
      return res.status(400).json({
        success: false,
        message: 'Date must be in YYYY-MM-DD format'
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if facility exists and is active
    const facilityCheck = await client.query(
      `SELECT f.id, f.name, f.booking_required, f.hourly_rate
       FROM facilities f
       WHERE f.id = $1 AND f.is_active = true`,
      [facilityId]
    );

    if (facilityCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Facility not found or not available for booking'
      });
    }

    const facility = facilityCheck.rows[0];

    // Check if booking is required for this facility
    if (!facility.booking_required) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'This facility does not require booking'
      });
    }

    // Check for overlapping bookings
    const overlapCheck = await client.query(
      `SELECT fb.id FROM facility_bookings fb
       WHERE fb.facility_id = $1
         AND fb.booking_date = $2
         AND fb.status IN ('confirmed', 'pending')
         AND (
           (fb.start_time < $4 AND fb.end_time > $3) OR
           (fb.start_time < $5 AND fb.end_time > $3) OR
           (fb.start_time >= $3 AND fb.end_time <= $5)
         )`,
      [facilityId, booking_date, start_time, end_time, end_time]
    );

    if (overlapCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Facility is already booked for the selected time slot'
      });
    }

    // Calculate total amount
    let totalAmount = 0;
    if (facility.hourly_rate) {
      const startTimeObj = new Date(`1970-01-01T${start_time}:00Z`);
      const endTimeObj = new Date(`1970-01-01T${end_time}:00Z`);
      const hoursDiff = (endTimeObj - startTimeObj) / (1000 * 60 * 60); // Convert to hours
      totalAmount = parseFloat(facility.hourly_rate) * hoursDiff;
    }

    // Create booking
    const result = await client.query(
      `INSERT INTO facility_bookings (facility_id, user_id, start_time, end_time, booking_date,
              purpose, status, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING id, facility_id, user_id, start_time, end_time, booking_date,
                 purpose, status, total_amount, created_at, updated_at`,
      [
        facilityId,
        userId,
        start_time,
        end_time,
        booking_date,
        purpose || null,
        totalAmount
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Facility booking request submitted successfully',
      data: {
        booking: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Facility booking error:', error);
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

// Get user's facility bookings
router.get('/my-bookings', authenticateToken, async (req, res) => {
  let client;
  try {
    const userId = req.user.userId;

    client = await pool.connect();

    const result = await client.query(
      `SELECT fb.id, fb.facility_id, fb.user_id, fb.start_time, fb.end_time, fb.booking_date,
              fb.purpose, fb.status, fb.total_amount, fb.created_at, fb.updated_at,
              f.name as facility_name, f.category as facility_category,
              s.name as society_name
       FROM facility_booking s ON fb.facility_id = f.id
       JOIN societies s ON f.society_id = s.id
       WHERE fb.user_id = $1
       ORDER BY fb.booking_date DESC, fb.created_at DESC`,
      [userId]
    );

    res.status(200).json({
      success: true,
      data: {
        bookings: result.rows
      }
    });
  } catch (error) {
    console.error('Get user facility bookings error:', error);
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