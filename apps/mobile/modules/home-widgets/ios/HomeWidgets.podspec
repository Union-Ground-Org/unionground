Pod::Spec.new do |s|
  s.name = 'HomeWidgets'
  s.version = '1.0.0'
  s.summary = 'Minimized foreground-authorized home-screen counts'
  s.description = 'Publishes counts and freshness metadata without credentials or member content.'
  s.author = 'Union Ground'
  s.homepage = 'https://unionground.org'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WidgetKit'
  s.source_files = '**/*.swift'
end
