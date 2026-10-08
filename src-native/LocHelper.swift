import Foundation
import CoreLocation
import Darwin

// Print a single JSON object to stdout and exit. Writing via FileHandle
// avoids stdio buffering issues when the process is launched with piped
// stdout from Node.
func emit(_ object: [String: Any], exitCode: Int32) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: []),
       let json = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((json + "\n").utf8))
    }
    exit(exitCode)
}

// --- Command-line arguments ---

// --maximum-age <milliseconds>: accept a fix no older than this. 0 (default)
// requires a fix obtained after the location request began (i.e. fresh).
var maximumAge: TimeInterval = 0
// --timeout <milliseconds>: exit with TIMEOUT after this long. 0 disables the
// deadline.
var timeoutMilliseconds: Double = 0

let arguments = CommandLine.arguments
if let index = arguments.firstIndex(of: "--maximum-age"), index + 1 < arguments.count {
    maximumAge = (Double(arguments[index + 1]) ?? 0) / 1000
}
if let index = arguments.firstIndex(of: "--timeout"), index + 1 < arguments.count {
    timeoutMilliseconds = Double(arguments[index + 1]) ?? 0
}

// --- Location provider ---

final class LocationProvider: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let maximumAge: TimeInterval
    private var startedAt: Date?

    init(maximumAge: TimeInterval) {
        self.maximumAge = maximumAge
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func start() {
        if !CLLocationManager.locationServicesEnabled() {
            emit([
                "ok": false,
                "code": "LOCATION_SERVICES_DISABLED",
                "message": "Location Services is disabled. Enable it in System Settings > Privacy & Security > Location Services.",
            ], exitCode: 1)
        }
        handleAuthorization(manager.authorizationStatus)
    }

    // A denial can mean the app lacks permission, or that the global Location
    // Services switch was turned off mid-request (which macOS reports as
    // .denied). Recheck so callers get the right recovery action.
    private func emitDenied() -> Never {
        if !CLLocationManager.locationServicesEnabled() {
            emit([
                "ok": false,
                "code": "LOCATION_SERVICES_DISABLED",
                "message": "Location Services is disabled. Enable it in System Settings > Privacy & Security > Location Services.",
            ], exitCode: 1)
        }
        emit([
            "ok": false,
            "code": "PERMISSION_DENIED",
            "message": "Location permission was denied. Enable it in System Settings > Privacy & Security > Location Services.",
        ], exitCode: 1)
    }

    private func handleAuthorization(_ status: CLAuthorizationStatus) {
        switch status {
        case .authorizedAlways, .authorizedWhenInUse:
            startedAt = Date()
            manager.startUpdatingLocation()
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied:
            emitDenied()
        case .restricted:
            emit([
                "ok": false,
                "code": "PERMISSION_RESTRICTED",
                "message": "Location permission is restricted (for example, by a management profile).",
            ], exitCode: 1)
        @unknown default:
            emit([
                "ok": false,
                "code": "PERMISSION_DENIED",
                "message": "Location permission is unavailable.",
            ], exitCode: 1)
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        handleAuthorization(manager.authorizationStatus)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else {
            return
        }

        if maximumAge > 0 {
            let age = Date().timeIntervalSince(location.timestamp)
            if age > maximumAge {
                return
            }
        } else if let startedAt, location.timestamp < startedAt {
            // A cached fix delivered before a fresh one; keep waiting.
            return
        }

        guard location.horizontalAccuracy >= 0 else {
            return
        }

        manager.stopUpdatingLocation()
        emit([
            "ok": true,
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracy": location.horizontalAccuracy,
            "timestamp": (location.timestamp.timeIntervalSince1970 * 1000).rounded(),
        ], exitCode: 0)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let code = (error as? CLError)?.code
        if code == .denied {
            emitDenied()
        }
        // locationUnknown (error 0) is transient; keep waiting for the next update.
        if code == .locationUnknown {
            return
        }
        manager.stopUpdatingLocation()
        emit([
            "ok": false,
            "code": "POSITION_UNAVAILABLE",
            "message": error.localizedDescription,
        ], exitCode: 1)
    }
}

// --- Bounded lifetime ---

// Exit once the deadline passes, so an orphaned helper cannot keep waiting for
// a location after its caller has given up.
if timeoutMilliseconds > 0 {
    Timer.scheduledTimer(withTimeInterval: timeoutMilliseconds / 1000, repeats: false) { _ in
        emit([
            "ok": false,
            "code": "TIMEOUT",
            "message": "No location within \(Int(timeoutMilliseconds.rounded())) ms",
        ], exitCode: 1)
    }
}

// When stdin is a pipe or socket pair, exit as soon as it closes. The caller
// holds the write end, so this fires when the caller process goes away — even
// if it is killed.
var stdinInfo = stat()
let stdinMode = fstat(STDIN_FILENO, &stdinInfo) == 0 ? stdinInfo.st_mode & mode_t(S_IFMT) : 0
if stdinMode == mode_t(S_IFIFO) || stdinMode == mode_t(S_IFSOCK) {
    Thread.detachNewThread {
        var byte: UInt8 = 0
        while read(STDIN_FILENO, &byte, 1) > 0 {}
        exit(0)
    }
}

// --- Entry point ---

let provider = LocationProvider(maximumAge: maximumAge)
provider.start()
RunLoop.main.run()
