Pod::Spec.new do |s|
  s.name           = 'NativeCalendarExport'
  s.version        = '1.0.0'
  s.summary        = 'Privacy-safe Union Ground device calendar export'
  s.description    = 'Presents the out-of-process system event composer for one user-confirmed calendar entry.'
  s.author         = 'Union Ground'
  s.homepage       = 'https://unionground.org'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'EventKit', 'EventKitUI'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
