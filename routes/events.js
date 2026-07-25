const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { pool } = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

// Validation schemas
const eventSchema = Joi.object({
  society_id: Joi.string().required(),
  title: Joi.string().required().min(3).max(255),
  description: Joi.string().optional(),
  event_date: Joi.date().iso().required(),
  start_time: Joi.string().regex(/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/).optional(), // HH:MM format
  end_time: Joi.string().regex(/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/).optional(),
  location: Joi.string().optional().max(255),
  organizer_uuid: Joi.string().optional(),
  max_attendees: Joi.number().integer().min(1).optional(),
  registration_required: Joi.boolean().default(false),
  registration_deadline: Joi.date().iso().optional().less(Joi.ref('event_date')),
  status: Joi.string().valid('planned', 'ongoing', 'completed', 'cancelled').default('planned')
});

// Get all events
router.get('/', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      `SELECT e.id, e.society_id, e.title, e.description, e.event_date, e.start_time, e.end_time,
              e.location, e.organizer_uuid, e.max_attendees, e.registration_required, e.registration_deadline,
              e.status, e.created_at, e.updated_at,
              s.name as society_name,
              o.full_name as organizer_name
       FROM events e
       JOIN societies s ON e.society_id = s.id
       LEFT JOIN profiles o ON e.organizer_uuid = o.id
       ORDER BY e.event_date DESC, e.created_at DESC`
    );

    res.status(200).json({
      success: true,
      data: {
        events: result.rows
      }
    });
  } catch (error) {
    console.error('Get events error:', error);
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

// Get events by society ID
router.get('/society/:societyId', authenticateToken, async (req, res) => {
  let client;
  try {
    const { societyId } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT e.id, e.society_id, e.title, e.description, e.event_date, e.start_time, e.end_time,
              e.location, e.organizer_uuid, e.max_attendees, e.registration_required, e.registration_deadline,
              e.status, e.created_at, e.updated_at,
              s.name as society_name,
              o.full_name as organizer_name
       FROM events e
       JOIN societies s ON e.society_id = s.id
       LEFT JOIN profiles o ON e.organizer_uuid = o.id
       WHERE e.society_id = $1
       ORDER BY e.event_date DESC, e.created_at DESC`,
      [societyId]
    );

    res.status(200).json({
      success: true,
      data: {
        events: result.rows
      }
    });
  } catch (error) {
    console.error('Get events by society error:', error);
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

// Get event by ID
router.get('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT e.id, e.society_id, e.title, e.description, e.event_date, e.start_time, e.end_time,
              e.location, e.organizer_uuid, e.max_attendees, e.registration_required, e.registration_deadline,
              e.status, e.created_at, e.updated_at,
              s.name as society_name,
              o.full_name as organizer_name
       FROM events e
       JOIN societies s ON e.society_id = s.id
       LEFT JOIN profiles o ON e.organizer_uuid = o.id
       WHERE e.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        event: result.rows[0]
      }
    });
  } catch (error) {
    console.error('Get event by ID error:', error);
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

// Create a new event
router.post('/', authenticateToken, authorizeRole('admin', 'resident'), async (req, res) => {
  let client;
  try {
    const { error, value } = eventSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Validate time format
    if (value.start_time && !/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.test(value.start_time)) {
      return res.status(400).json({
        success: false,
        message: 'Start time must be in HH:MM format'
      });
    }

    if (value.end_time && !/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.test(value.end_time)) {
      return res.status(400).json({
        success: false,
        message: 'End time must be in HH:MM format'
      });
    }

    // Validate that end_time is after start_time
    if (value.start_time && value.end_time) {
      const startTime = new Date(`1970-01-01T${value.start_time}:00Z`);
      const endTime = new Date(`1970-01-01T${value.end_time}:00Z`);
      if (endTime <= startTime) {
        return res.status(400).json({
          success: false,
          message: 'End time must be after start time'
        });
      }
    }

    // Validate registration deadline is before event date
    if (value.registration_deadline && value.event_date) {
      const deadline = new Date(value.registration_deadline);
      const eventDate = new Date(value.event_date);
      if (deadline >= eventDate) {
        return res.status(400).json({
          success: false,
          message: 'Registration deadline must be before event date'
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
      return res.status(404).json({
        success: false,
        message: 'Society not found'
      });
    }

    // Verify organizer exists (if provided)
    if (value.organizer_uuid) {
      const organizerCheck = await client.query(
        'SELECT id FROM profiles WHERE id = $1',
        [value.organizer_uuid]
      );

      if (organizerCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Organizer not found'
        });
      }
    }

    const result = await client.query(
      `INSERT INTO events (society_id, title, description, event_date, start_time, end_time, location,
              organizer_uuid, max_attendees, registration_required, registration_deadline, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, society_id, title, description, event_date, start_time, end_time, location,
                 organizer_uuid, max_attendees, registration_required, registration_deadline,
                 status, created_at, updated_at`,
      [
        value.society_id,
        value.title,
        value.description || null,
        value.event_date,
        value.start_time || null,
        value.end_time || null,
        value.location || null,
        value.organizer_uuid || null,
        value.max_attendees || null,
        value.registration_required,
        value.registration_deadline || null,
        value.status,
        req.user.userId
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Event created successfully',
      data: {
        event: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Create event error:', error);
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

// Update event
router.put('/:id', authenticateToken, authorizeRole('admin', 'resident'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { error, value } = eventSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Validate time format
    if (value.start_time && !/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.test(value.start_time)) {
      return res.status(400).json({
        success: false,
        message: 'Start time must be in HH:MM format'
      });
    }

    if (value.end_time && !/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.test(value.end_time)) {
      return res.status(400).json({
        success: false,
        message: 'End time must be in HH:MM format'
      });
    }

    // Validate that end_time is after start_time
    if (value.start_time && value.end_time) {
      const startTime = new Date(`1970-01-01T${value.start_time}:00Z`);
      const endTime = new Date(`1970-01-01T${value.end_time}:00Z`);
      if (endTime <= startTime) {
        return res.status(400).json({
          success: false,
          message: 'End time must be after start time'
        });
      }
    }

    // Validate registration deadline is before event date
    if (value.registration_deadline && value.event_date) {
      const deadline = new Date(value.registration_deadline);
      const eventDate = new Date(value.event_date);
      if (date >= eventDate) {
        return res.status(400).json({
          success: false,
          message: 'Registration deadline must be before event date'
        });
      }
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if event exists
    const checkResult = await client.query('SELECT id FROM events WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Event not found'
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

    // Verify organizer exists (if provided)
    if (value.organizer_uuid) {
      const organizerCheck = await client.query(
        'SELECT id FROM profiles WHERE id = $1',
        [value.organizer_uuid]
      );

      if (organizerCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Organizer not found'
        });
      }
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let index = 1;

    for (const key of Object.keys(value)) {
      if (value[key] !== undefined) {
        // Special handling for time fields to ensure proper format
        if ((key === 'start_time' || key === 'end_time') && value[key] !== null) {
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
    const nullableFields = ['description', 'location', 'organizer_uuid', 'max_attendees', 'registration_deadline'];
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

    // Add event ID for WHERE clause
    values.push(id);

    const queryText = `
      UPDATE events
      SET ${updates.join(', ')}
      WHERE id = $${index}
      RETURNING id, society_id, title, description, event_date, start_time, end_time, location,
                organizer_uuid, max_attendees, registration_required, registration_deadline,
                status, created_at, updated_at
    `;

    const result = await client.query(queryText, values);
    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Event updated successfully',
      data: {
        event: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update event error:', error);
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

// Delete event
router.delete('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if event exists
    const checkResult = await client.query('SELECT id FROM events WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Delete event
    await client.query('DELETE FROM events WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Event deleted successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Delete event error:', error);
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

// Event registration endpoints
// Register for an event
router.post('/:id/register', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id: eventId } = req.params;
    const attendeeId = req.user.userId; // Current user

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if event exists and is open for registration
    const eventCheck = await client.query(
      `SELECT e.id, e.registration_required, e.registration_deadline, e.max_attendees,
              COUNT(ea.id) as current_attendees
       FROM events e
       LEFT JOIN event_attendees ea ON e.id = ea.event_id
       WHERE e.id = $1
       GROUP BY e.id, e.registration_required, e.registration_deadline, e.max_attendees`,
      [eventId]
    );

    if (eventCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    const event = eventCheck.rows[0];

    // Check if registration is required
    if (!event.registration_required) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Registration is not required for this event'
      });
    }

    // Check registration deadline
    if (event.registration_deadline) {
      const deadline = new Date(event.registration_deadline);
      const now = new Date();
      if (now > deadline) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Registration deadline has passed'
        });
      }
    }

    // Check if maximum attendees reached
    if (event.max_attendees && parseInt(event.current_attendees) >= event.max_attendees) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Maximum number of attendees reached'
      });
    }

    // Check if already registered
    const existingRegistration = await client.query(
      'SELECT id FROM event_attendees WHERE event_id = $1 AND profile_id = $2',
      [eventId, attendeeId]
    );

    if (existingRegistration.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Already registered for this event'
      });
    }

    // Register for the event
    const result = await client.query(
      `INSERT INTO event_attendees (event_id, profile_id, rsvp_status)
       VALUES ($1, $2, 'confirmed')
       RETURNING id, event_id, profile_id, rsvp_status, attended, feedback_rating, feedback_comments,
                 registered_at, updated_at`,
      [eventId, attendeeId]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Registered for event successfully',
      data: {
        registration: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Event registration error:', error);
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

// Get attendees for an event
router.get('/:id/attendees', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id: eventId } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT ea.id, ea.event_id, ea.profile_id, ea.rsvp_status, ea.attended, ea.feedback_rating,
              ea.feedback_comments, ea.registered_at, ea.updated_at,
              p.full_name, p.email, p.phone
       FROM event_attendees ea
       JOIN profiles p ON ea.profile_id = p.id
       WHERE ea.event_id = $1
       ORDER BY ea.registered_at`,
      [eventId]
    );

    res.status(200).json({
      success: true,
      data: {
        attendees: result.rows
      }
    });
  } catch (error) {
    console.error('Get event attendees error:', error);
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