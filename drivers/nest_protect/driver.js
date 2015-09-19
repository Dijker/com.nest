/**
 * Import nest driver and underscore
 */
var nestDriver = require( '../nest_driver.js' );
var _ = require( 'underscore' );

/**
 * devices stores all devices registered on the users nest account
 * installedDevices is an array holding the ID's of installed devices
 */
var devices = [];
var installedDevices = [];

/**
 * Initially store devices present on Homey, and try to authenticate
 * @param devices_data
 * @param callback
 */
module.exports.init = function ( devices_data, callback ) {

    // Pass already installed devices to nestDriver
    devices_data.forEach( function ( device_data ) {

        // Get stored access_token
        nestDriver.credentials.access_token = device_data.access_token;

        // Register installed devices
        installedDevices.push( device_data.id );
    } );

    // Authenticate
    nestDriver.authWithToken( function ( success ) {
        if ( success ) {
            // Already authorized
            Homey.log( 'Authorization with Nest successful' );
        }
        else {
            // Get new access_token and authenticate with Nest
            Homey.log( 'Initializing driver failed, try adding devices.' );

        }
    } );

    // Fetch data
    nestDriver.fetchDeviceData( 'smoke_co_alarms', devices );

    // And keep listening for updated data
    nestDriver.events.on( 'smoke_co_alarms_devices', function ( data ) {
        devices = data[ 0 ];
        installedDevices = _.intersection( installedDevices, data[ 1 ] );
    } );

    // Start listening to alarms
    listenForAlarms();

    // Ready
    callback( true );
};

/**
 * Pairing process that starts with authentication with nest, and declares some callbacks when devices are added and
 * removed
 */
module.exports.pair = {

    /**
     * Passes credentials to front-end, to be used to construct the authorization url,
     * gets called when user initiates pairing process
     */
    authenticate: function ( callback, emit ) {

        // Authenticate using access_token
        nestDriver.authWithToken( function ( success ) {
            if ( success ) {
                Homey.log( 'Authorization with Nest successful' );

                // Continue to list devices
                callback( true );
            }
            else {

                // Get new access_token and authenticate with Nest
                nestDriver.fetchAccessToken( function ( result ) {

                    callback( result );
                }, emit );
            }
        } );
    },

    /**
     * Called when user is presented the list_devices template,
     * this function fetches all available devices from the Nest
     * API and displays them to be selected by the user for adding
     */
    list_devices: function ( callback ) {

        // Create device list from found devices
        var devices_list = [];
        devices.forEach( function ( device ) {
            devices_list.push( {
                data: {
                    id: device.data.id,
                    access_token: nestDriver.credentials.access_token
                },
                name: device.name
            } );
        } );

        // Return list to front-end
        callback( devices_list );
    },

    /**
     * When a user adds a device, make sure the driver knows about it
     */
    add_device: function ( callback, emit, device ) {

        // Mark device as installed
        installedDevices.push( device.data.id );
    }
};

/**
 * These represent the capabilities of the Nest Protect
 */
module.exports.capabilities = {

    alarm_co: {
        get: function ( device_data, callback ) {
            if ( device_data instanceof Error ) return callback( device_data );

            // Get device data
            var protect = nestDriver.getDevice( devices, installedDevices,  device_data.id );
            if ( !protect ) return callback( device_data );

            var value = (protect.data.co_alarm_state !== 'ok');
            if ( callback ) callback( value );

            // Return casted boolean of co_alarm (int)
            return value;
        }
    },

    alarm_co2: {
        get: function ( device_data, callback ) {
            if ( device_data instanceof Error ) return callback( device_data );

            // Get device data
            var protect = nestDriver.getDevice( devices, installedDevices,  device_data.id );
            if ( !protect ) return callback( device_data );

            var value = (protect.data.smoke_alarm_state !== 'ok');
            if ( callback ) callback( value );

            // Return casted boolean of smoke_alarm_state (int)
            return value;
        }
    },

    alarm_battery: {
        get: function ( device_data, callback ) {
            if ( device_data instanceof Error ) return callback( device_data );

            // Get device data
            var protect = nestDriver.getDevice( devices, installedDevices,  device_data.id );
            if ( !protect ) return callback( device_data );

            var value = (protect.data.battery_health !== 'ok');
            if ( callback ) callback( value );

            // Return casted boolean of battery_health (int)
            return value;
        }
    }
};

/**
 * When a device gets deleted, make sure to clean up
 * @param device_data
 */
module.exports.deleted = function ( device_data ) {

    // Remove ID from installed devices array
    for ( var x = 0; x < installedDevices.length; x++ ) {
        if ( installedDevices[ x ] === device_data.id ) {
            installedDevices = _.reject( installedDevices, function ( id ) {
                return id === device_data.id;
            } );
        }
    }
};

/**
 * Disables previous connections and creates new listeners on the updated set of installed devices
 */
function listenForAlarms () {

    // Remove possible previous listeners
    nestDriver.socket.child( 'devices/smoke_co_alarms' ).off();

    // Listen for incoming value events
    nestDriver.socket.child( 'devices/smoke_co_alarms' ).once( 'value', function ( snapshot ) {

            for ( var id in snapshot.val() ) {
                var device = snapshot.child( id );

                var device_id = snapshot.child( id ).child( 'device_id' ).val();

                // Only listen on added device
                if ( nestDriver.getDevice( devices, installedDevices,  device_id ) ) {

                    listenForSmokeAlarms( device );

                    listenForCOAlarms( device );

                    listenForBatteryAlarms( device );
                }
            }
        }
    );
};

/**
 * Listen for smoke alarms on a Protect
 */
function listenForSmokeAlarms ( device ) {
    var deviceState;
    device.child( 'smoke_alarm_state' ).ref().off();
    device.child( 'smoke_alarm_state' ).ref().on( 'value', function ( state ) {
        var device_data = nestDriver.getDevice( devices, installedDevices,  device.child( 'device_id' ).val() ).data;

        switch ( state.val() ) {
            case 'warning':
                if ( deviceState !== 'warning' && device_data ) { // only alert the first change

                    // Update alarm_co2
                    module.exports.realtime( device_data, 'alarm_co2', true );
                }
                break;
            case 'emergency':
                if ( deviceState !== 'emergency' && device_data ) { // only alert the first change

                    // Update alarm_co2
                    module.exports.realtime( device_data, 'alarm_co2', true );
                }
                break;
            default:

                // Update alarm_co2
                module.exports.realtime( device_data, 'alarm_co2', false );
        }
        deviceState = state.val();
    } );
};

/**
 * Listen for CO alarms on a Protect
 */
function listenForCOAlarms ( device ) {
    var deviceState;
    device.child( 'co_alarm_state' ).ref().off();
    device.child( 'co_alarm_state' ).ref().on( 'value', function ( state ) {
        var device_data = nestDriver.getDevice( devices, installedDevices,  device.child( 'device_id' ).val() ).data;

        switch ( state.val() ) {
            case 'warning':
                if ( deviceState !== 'warning' && device_data ) { // only alert the first change

                    // Update alarm_co
                    module.exports.realtime( device_data, 'alarm_co', true );
                }
                break;
            case 'emergency':
                if ( deviceState !== 'emergency' && device_data ) { // only alert the first change

                    // Update alarm_co
                    module.exports.realtime( device_data, 'alarm_co', true );
                }
                break;
            default:
                // Update alarm_co
                module.exports.realtime( device_data, 'alarm_co', false );
        }
        deviceState = state.val();
    } );
};

/**
 * Listen for low battery on a Protect
 */
function listenForBatteryAlarms ( device ) {
    device.child( 'battery_health' ).ref().off();
    device.child( 'battery_health' ).ref().on( 'value', function ( state ) {
        var device_data = nestDriver.getDevice( devices, installedDevices,  device.child( 'device_id' ).val() ).data;

        // Don't show battery alerts if a more
        // important alert is already showing
        if ( state.val() === 'replace' &&
            device.child( 'smoke_alarm_state' ).val() === 'ok' &&
            device.child( 'co_alarm_state' ).val() === 'ok' &&
            device_data ) {

            // Update battery_empty
            module.exports.realtime( device_data, 'alarm_battery', true );
        }
        else {
            // Update battery_empty
            module.exports.realtime( device_data, 'alarm_battery', false );
        }
    } );
};